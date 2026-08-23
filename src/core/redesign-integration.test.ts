import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SceneConsolidator } from "./scene/scene-consolidator.js";
import { generateActiveScenes } from "./scene/scene-navigation.js";
import { readSceneIndex } from "./scene/scene-index.js";
import { parseSceneFileV2 } from "./scene/scene-format.js";
import type { LLMRunner } from "./types.js";
import type { EmbeddingService } from "./store/embedding.js";

/** Fake embedding: texts containing 基础设施 → axis A, everything else → axis B. */
function fakeEmbeddingService(): EmbeddingService {
  return {
    embed: async (text: string) => (text.includes("基础设施") ? new Float32Array([1, 0, 0, 0]) : new Float32Array([0, 1, 0, 0])),
    embedBatch: async (texts: string[]) => texts.map((t) => (t.includes("基础设施") ? new Float32Array([1, 0, 0, 0]) : new Float32Array([0, 1, 0, 0]))),
    getDimensions: () => 4,
    getProviderInfo: () => ({ provider: "fake", model: "fake", dimensions: 4 }) as never,
    isReady: () => true,
    startWarmup: () => {},
    close: async () => {},
  } as unknown as EmbeddingService;
}

function fakeLLMRunner(): LLMRunner {
  return {
    run: async () => JSON.stringify({ title: "生活-烹饪实践", summary: "正在整理家常菜谱并优化备菜流程" }),
  };
}

const HEALTHY_LEGACY = `-----META-START-----
created: 2026-06-28T12:06:45.505Z
updated: 2026-08-20T15:24:18.485Z
summary: 测试基建场景的正常摘要
heat: 3
last_full_rewrite_at: 2026-08-20T15:24:18.485Z
-----META-END-----

## User Core Traits
真实叙事内容若干。`;

/** The production husk pattern: corrupted META + wiped body. */
const HUSK = `-----META-START-----
created: updated: 2026-08-20T15:24:18.485Z
updated: 2026-08-20T17:05:01.163Z
summary: heat: 0
heat: 0
last_full_rewrite_at: 2026-08-20T17:05:01.163Z
-----META-END-----

[工程截断：原始长度 2150 字符，已截断至 2000 字符上限]`;

const STALE_V2 = `-----META-START-----
title: 已过期的陈年主题
created: 2026-03-01T00:00:00.000Z
updated: 2026-03-01T00:00:00.000Z
first_active: 2026-03-01T00:00:00.000Z
last_active: 2026-03-05T00:00:00.000Z
summary: 早已不再活动的主题
memory_count: 2
-----META-END-----

## Memory Pointers
- m_old_1 | 2026-03-01 | 旧记忆一
- m_old_2 | 2026-03-05 | 旧记忆二
`;

describe("L2 v2 redesign integration", () => {
  let tmpDir: string;
  let blocksDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-redesign-"));
    blocksDir = path.join(tmpDir, "scene_blocks");
    await fs.mkdir(blocksDir, { recursive: true });
    await fs.writeFile(path.join(blocksDir, "基础设施-测试.md"), HEALTHY_LEGACY, "utf-8");
    await fs.writeFile(path.join(blocksDir, "AI架构-已损坏.md"), HUSK, "utf-8");
    await fs.writeFile(path.join(blocksDir, "check_file.sh"), "#!/bin/bash\nwc -l\n", "utf-8");
    await fs.writeFile(path.join(blocksDir, "陈年主题.md"), STALE_V2, "utf-8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeConsolidator(): SceneConsolidator {
    return new SceneConsolidator({
      dataDir: tmpDir,
      llmRunner: fakeLLMRunner(),
      embeddingService: fakeEmbeddingService(),
      ttlDays: 30,
      routingThreshold: 0.3,
      promoteThresholdMemories: 5,
      promoteThresholdSessions: 3,
      summaryRefreshDays: 7,
      summaryRefreshNewMemories: 5,
      summaryMaxChars: 80,
    });
  }

  it("end-to-end: migration → TTL eviction → routing → promotion → injection", async () => {
    const consolidator = makeConsolidator();

    const result = await consolidator.consolidate([
      // 2 memories aligned with the migrated scene's anchor (axis A)
      ...[1, 2].map((i) => ({
        id: `m_route_${i}`,
        content: `基础设施第${i}次调整记录`,
        sceneName: "infra work",
        createdAt: `2026-08-2${i}T10:00:00.000Z`,
        sessionKey: "session-routed",
        embedding: new Float32Array([0.9, 0.1, 0, 0]),
      })),
      // 5 orthogonal memories → one candidate → promotion
      ...[1, 2, 3, 4, 5].map((i) => ({
        id: `m_cook_${i}`,
        content: `cooking recipe experiment number ${i}`,
        sceneName: "cooking",
        createdAt: `2026-08-1${i}T10:00:00.000Z`,
        sessionKey: "session-cooking",
        embedding: new Float32Array([0, 1, 0, 0]),
      })),
    ]);

    // ── Migration ──
    expect(result.migrated).toBe(1); // healthy legacy converted
    expect(result.husksArchived).toBe(2); // husk scene + check_file.sh
    const migratedRaw = await fs.readFile(path.join(blocksDir, "基础设施-测试.md"), "utf-8");
    const migrated = parseSceneFileV2(migratedRaw);
    expect(migrated).not.toBeNull();
    expect(migrated!.meta.title).toBe("基础设施-测试");
    expect(migrated!.meta.first_active).toBe("2026-06-28T12:06:45.505Z");
    expect(migrated!.meta.summary).toContain("正常摘要");

    const huskDir = path.join(tmpDir, ".backup", "scene_blocks_husks");
    expect(await fs.readFile(path.join(huskDir, "check_file.sh"), "utf-8")).toBeTruthy();
    await expect(fs.readFile(path.join(huskDir, "AI架构-已损坏.md"), "utf-8")).resolves.toContain("工程截断");

    // ── TTL eviction ──
    expect(result.expiredArchived).toBe(1); // 陈年主题 (last_active 2026-03-05)
    await expect(fs.readFile(path.join(blocksDir, "陈年主题.md"), "utf-8")).rejects.toThrow();
    await expect(
      fs.readFile(path.join(tmpDir, ".backup", "scene_blocks_expired", "陈年主题.md"), "utf-8"),
    ).resolves.toContain("陈年主题");

    // ── Routing ──
    expect(result.routedScenes).toBe(1);
    expect(result.promotedScenes).toBe(1);
    const routedAgain = parseSceneFileV2(await fs.readFile(path.join(blocksDir, "基础设施-测试.md"), "utf-8"));
    expect(routedAgain!.meta.memory_count).toBe(2);
    expect(routedAgain!.pointers.map((p) => p.id).sort()).toEqual(["m_route_1", "m_route_2"]);
    expect(routedAgain!.meta.last_active).toBe("2026-08-22T10:00:00.000Z");
    // 2 < refreshNewMemories(5) and fresh → no summary refresh
    expect(result.refreshedSummaries).toBe(0);

    // ── Promotion ──
    const promotedRaw = await fs.readFile(path.join(blocksDir, "生活-烹饪实践.md"), "utf-8");
    const promoted = parseSceneFileV2(promotedRaw);
    expect(promoted).not.toBeNull();
    expect(promoted!.meta.title).toBe("生活-烹饪实践");
    expect(promoted!.meta.summary).toBe("正在整理家常菜谱并优化备菜流程");
    expect(promoted!.pointers).toHaveLength(5);
    expect(promoted!.meta.first_active).toBe("2026-08-11T10:00:00.000Z");

    // ── Index + injection ──
    const index = await readSceneIndex(tmpDir);
    expect(index.map((e) => e.title).sort()).toEqual(["基础设施-测试", "生活-烹饪实践"]);

    const activeText = generateActiveScenes(index, 30, new Date("2026-08-23T00:00:00Z"));
    expect(activeText).toContain("基础设施-测试 (2026-06-28 ~ 08-22)");
    expect(activeText).toContain("记忆: 2条");
    expect(activeText).toContain("生活-烹饪实践");
    expect(activeText).toContain("正在整理家常菜谱");
    expect(activeText).not.toContain("陈年主题");
  });

  it("generateActiveScenes filters entries beyond TTL regardless of count", () => {
    const now = new Date("2026-08-23T00:00:00Z");
    const entries = [
      {
        filename: "a.md", title: "主题A", summary: "sa",
        created: "2026-08-01T00:00:00Z", updated: "2026-08-22T00:00:00Z",
        first_active: "2026-08-01T00:00:00Z", last_active: "2026-08-22T00:00:00Z", memory_count: 3,
      },
      {
        filename: "b.md", title: "主题B", summary: "sb",
        created: "2026-01-01T00:00:00Z", updated: "2026-01-02T00:00:00Z",
        first_active: "2026-01-01T00:00:00Z", last_active: "2026-07-01T00:00:00Z", memory_count: 9,
      },
      {
        filename: "c.md", title: "主题C", summary: "sc",
        created: "2026-08-20T00:00:00Z", updated: "2026-08-20T00:00:00Z",
        first_active: "2026-08-20T00:00:00Z", last_active: "2026-08-20T00:00:00Z", memory_count: 1,
      },
    ];

    const text = generateActiveScenes(entries, 30, now);
    // No top-K cap: both in-TTL entries present (2 of 3)
    expect(text).toContain("主题A");
    expect(text).toContain("主题C");
    expect(text).not.toContain("主题B");
    // Sorted by recency: C (08-20) … wait A is 08-22 > C 08-20 → A first
    expect(text.indexOf("主题A")).toBeLessThan(text.indexOf("主题C"));
  });

  it("empty batch still performs migration (plugin upgrade with no new memories)", async () => {
    const consolidator = makeConsolidator();
    const result = await consolidator.consolidate([]);
    expect(result.migrated).toBe(1);
    expect(result.husksArchived).toBe(2);
    // Second run: migration is idempotent (guarded by state flag)
    const again = await consolidator.consolidate([]);
    expect(again.migrated).toBe(0);
    expect(again.husksArchived).toBe(0);
  });
});

import { describe, it, expect } from "vitest";
import {
  parseSceneFileV2,
  formatSceneFileV2,
  migrateLegacyScene,
  capSceneSummary,
  sanitizeSceneFilenameStem,
  SUMMARY_MAX_CHARS,
} from "./scene-format.js";

const NOW = "2026-08-22T00:00:00.000Z";

describe("scene-format v2", () => {
  it("round-trips meta and pointers", () => {
    const meta = {
      title: "货运业务-LCL拼箱装箱算法",
      created: NOW,
      updated: NOW,
      first_active: "2026-06-28T12:06:45.505Z",
      last_active: "2026-08-20T15:24:18.485Z",
      summary: "装箱规则手册已扩至28条",
      memory_count: 2,
    };
    const pointers = [
      { id: "m_1", ts: "2026-08-20", head: "最新记忆" },
      { id: "m_2", ts: "2026-06-28", head: "最早记忆" },
    ];
    const raw = formatSceneFileV2(meta, pointers);
    const parsed = parseSceneFileV2(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.meta).toEqual(meta);
    expect(parsed!.pointers).toEqual(pointers);
  });

  it("returns null for legacy files (no title / has heat)", () => {
    const legacy = `-----META-START-----
created: 2026-06-28T12:06:45.505Z
updated: 2026-08-20T15:24:18.485Z
summary: legacy scene
heat: 3
last_full_rewrite_at: 2026-08-20T15:24:18.485Z
-----META-END-----

body`;
    expect(parseSceneFileV2(legacy)).toBeNull();
  });

  it("caps the file pointer list but records the remainder", () => {
    const meta = { title: "t", created: NOW, updated: NOW, first_active: NOW, last_active: NOW, summary: "s", memory_count: 150 };
    const pointers = Array.from({ length: 150 }, (_, i) => ({ id: `m_${i}`, ts: "2026-08-01", head: "h" }));
    const raw = formatSceneFileV2(meta, pointers);
    expect(raw).toContain("另有 50 条记忆");
    const parsed = parseSceneFileV2(raw);
    expect(parsed!.pointers).toHaveLength(100);
  });
});

describe("migrateLegacyScene", () => {
  it("converts a healthy legacy file, dropping the narrative body", () => {
    const raw = `-----META-START-----
created: 2026-06-28T12:06:45.505Z
updated: 2026-08-20T15:24:18.485Z
summary: Jerry 在做的测试基建场景
heat: 3
last_full_rewrite_at: 2026-08-20T15:24:18.485Z
-----META-END-----

## User Core Traits
很长的叙事正文……`;
    const { block, healthy } = migrateLegacyScene(raw, "基础设施-测试.md", NOW);
    expect(healthy).toBe(true);
    expect(block.meta.title).toBe("基础设施-测试");
    expect(block.meta.first_active).toBe("2026-06-28T12:06:45.505Z");
    expect(block.meta.last_active).toBe("2026-08-20T15:24:18.485Z");
    expect(block.meta.summary).toBe("Jerry 在做的测试基建场景");
    expect(block.pointers).toHaveLength(0);
  });

  it("flags the production husk (corrupted META + wiped body) as unhealthy", () => {
    const raw = `-----META-START-----
created: updated: 2026-08-20T15:24:18.485Z
updated: 2026-08-20T17:05:01.163Z
summary: heat: 0
heat: 0
last_full_rewrite_at: 2026-08-20T17:05:01.163Z
-----META-END-----

[工程截断：原始长度 2150 字符，已截断至 2000 字符上限]`;
    const { healthy } = migrateLegacyScene(raw, "AI架构-已损坏.md", NOW);
    expect(healthy).toBe(false);
  });

  it("salvages timestamps from corrupted legacy META and derives summary", () => {
    const raw = `-----META-START-----
created: updated: 2026-06-28T12:06:45.505Z
updated: 2026-08-20T17:05:01.163Z
summary: heat: 0
heat: 0
last_full_rewrite_at: 2026-08-20T17:05:01.163Z
-----META-END-----

## 第一行标题
真实正文内容还在。`;
    const { block, healthy } = migrateLegacyScene(raw, "场景.md", NOW);
    expect(healthy).toBe(true);
    // Salvaged the timestamp embedded in the merged-field garbage
    expect(block.meta.first_active).toBe("2026-06-28T12:06:45.505Z");
    expect(block.meta.last_active).toBe("2026-08-20T17:05:01.163Z");
    // Swallowed summary replaced by the first body line
    expect(block.meta.summary).toContain("第一行标题");
  });

  it("caps legacy summaries to the summary budget", () => {
    const raw = `-----META-START-----
created: 2026-06-28T12:06:45.505Z
updated: 2026-08-20T15:24:18.485Z
summary: ${"长".repeat(300)}
heat: 1
last_full_rewrite_at: 2026-08-20T15:24:18.485Z
-----META-END-----

正文`;
    const { block } = migrateLegacyScene(raw, "s.md", NOW);
    expect(Array.from(block.meta.summary).length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS + 1);
    expect(block.meta.summary.endsWith("…")).toBe(true);
  });
});

describe("helpers", () => {
  it("capSceneSummary truncates by code points with ellipsis", () => {
    expect(capSceneSummary("短", 80)).toBe("短");
    const capped = capSceneSummary("a".repeat(100), 80);
    expect(Array.from(capped).length).toBe(81);
    expect(capped.endsWith("…")).toBe(true);
  });

  it("sanitizeSceneFilenameStem strips punctuation and collapses separators", () => {
    expect(sanitizeSceneFilenameStem("Coffee (Yirgacheffe)")).toBe("Coffee-Yirgacheffe");
    expect(sanitizeSceneFilenameStem("技术研究 Rust  学习")).toBe("技术研究-Rust-学习");
    expect(sanitizeSceneFilenameStem("???")).toBe("scene");
  });
});

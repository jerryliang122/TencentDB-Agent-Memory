import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performAutoRecall } from "./auto-recall.js";
import type { IMemoryStore, L1SearchResult, L1FtsResult } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { MemoryTdaiConfig } from "../../config.js";

/**
 * Tests for session-anchored recall (`recall.sessionMode`):
 *   - session-first priming (anchor + injected ids returned)
 *   - priming vector gate (chitchat / no-history passes through clean)
 *   - drift: same-topic turn skips, topic-switch re-primes with dedup
 *   - fail-safe on drift-check embed error
 *   - first-turn mode never re-recalls
 *   - sceneInjection off/ambient
 *
 * Strategy: mock vectorStore + embeddingService with controlled vectors —
 * [1,0] vs [0,1] gives cosine 0 (drift), identical vectors give cosine 1.
 */

function makeL1Hit(overrides: Partial<L1SearchResult> = {}): L1SearchResult {
  return {
    record_id: "m_test",
    content: "some content",
    type: "fact",
    priority: 0.5,
    scene_name: "general",
    score: 0.5,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    session_key: "",
    session_id: "",
    metadata_json: "{}",
    ...overrides,
  };
}

function makeFtsHit(overrides: Partial<L1FtsResult> = {}): L1FtsResult {
  return {
    record_id: "m_test",
    content: "some content",
    type: "fact",
    priority: 0.5,
    scene_name: "general",
    score: 0.5,
    timestamp_str: "",
    timestamp_start: "",
    timestamp_end: "",
    session_key: "",
    session_id: "",
    metadata_json: "{}",
    ...overrides,
  };
}

function makeStore(opts: { vecResults?: L1SearchResult[]; ftsResults?: L1FtsResult[] } = {}) {
  const searchL1Vector = vi.fn(() => Promise.resolve(opts.vecResults ?? []));
  const searchL1Fts = vi.fn(() => Promise.resolve(opts.ftsResults ?? []));
  const store = {
    supportsDeferredEmbedding: false,
    init: () => ({ ok: true, ftsAvailable: true }),
    isDegraded: () => false,
    getCapabilities: () => ({ nativeHybridSearch: false, supportsDeferredEmbedding: false, bm25Local: false }),
    close: () => {},
    upsertL1: () => true,
    deleteL1: () => true,
    deleteL1Batch: () => true,
    deleteL1Expired: () => 0,
    countL1: () => 0,
    queryL1Records: () => [],
    getAllL1Texts: () => [],
    getL1ById: () => null,
    searchL1Vector,
    searchL1Fts,
    upsertL0: () => true,
    deleteL0: () => 0,
    deleteL0Expired: () => 0,
    countL0: () => 0,
    queryL0ForL1: () => [],
    queryL0GroupedBySession: () => [],
    getAllL0Texts: () => [],
    searchL0Vector: () => [],
    searchL0Fts: () => [],
    reindexAll: async () => ({ l1Count: 0, l0Count: 0 }),
    isFtsAvailable: () => true,
  };
  return { store: store as unknown as IMemoryStore, searchL1Vector, searchL1Fts };
}

/** Embedding mock mapping text substrings to vectors; tracks calls. */
function makeEmbedder(vectors: Record<string, number[]>, fallback: number[] = [0.5, 0.5]) {
  const embed = vi.fn(async (text: string) => {
    const key = Object.keys(vectors).find((k) => text.includes(k));
    return new Float32Array(key ? vectors[key] : fallback);
  });
  return { svc: { embed } as unknown as EmbeddingService, embed };
}

function makeCfg(recallOverrides: Partial<MemoryTdaiConfig["recall"]> = {}, persona?: Partial<MemoryTdaiConfig["persona"]>) {
  return {
    recall: {
      enabled: true,
      maxResults: 5,
      maxCharsPerMemory: 0,
      maxTotalRecallChars: 0,
      scoreThreshold: 0.3,
      ftsScoreThreshold: 0.35,
      minQueryChars: 6,
      strategy: "hybrid",
      timeoutMs: 5000,
      subjectOnly: true,
      subjectHintChars: 60,
      persistToTranscript: true,
      sessionMode: "drift",
      primingScoreThreshold: 0.62,
      driftThreshold: 0.5,
      sessionTtlMinutes: 30,
      sceneInjection: "off",
      ...recallOverrides,
    },
    persona: { sceneTtlDays: 30, ...persona },
  } as unknown as MemoryTdaiConfig;
}

const baseParams = {
  userText: "帮我优化数据库 schema",
  actorId: "",
  sessionKey: "s1",
  pluginDataDir: "/tmp/memory-tdai-test-no-scene-index",
};

describe("session-first priming", () => {
  it("recalls, returns the anchor and injected record ids", async () => {
    const { store } = makeStore({ vecResults: [makeL1Hit({ record_id: "m_1", content: "数据库 schema 历史决策", score: 0.9 })] });
    const { svc, embed } = makeEmbedder({ "帮我优化数据库 schema": [1, 0] });

    const result = await performAutoRecall({ ...baseParams, cfg: makeCfg(), vectorStore: store, embeddingService: svc, session: { mode: "drift", hasAnchor: false, driftThreshold: 0.5 } });

    expect(result?.prependContext).toContain("m_1");
    expect(result?.prependContext).toContain("<relevant-memories>");
    expect(result?.recallStrategy).toBe("session-first");
    expect(result?.sessionUpdate?.decision).toBe("session-first");
    expect(result?.sessionUpdate?.anchorText).toBe("帮我优化数据库 schema");
    expect(result?.sessionUpdate?.anchorEmbedding).toEqual([1, 0]);
    expect(result?.sessionUpdate?.newRecordIds).toEqual(["m_1"]);
    // Guide is injected to the system prompt; scenes are NOT (sceneInjection=off)
    expect(result?.appendSystemContext).toContain("<memory-tools-guide>");
    expect(result?.appendSystemContext).not.toContain("<active-scenes>");
    // Hybrid path embeds the query exactly once
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it("vector gate blocks injection when the best vector score is below primingScoreThreshold (chitchat)", async () => {
    // score 0.4 passes scoreThreshold=0.3 but is below the gate=0.62
    const { store, searchL1Vector } = makeStore({ vecResults: [makeL1Hit({ record_id: "m_weak", content: "弱相关内容", score: 0.4 })] });
    const { svc } = makeEmbedder({ 今天天气不错: [0, 1] });

    const result = await performAutoRecall({
      ...baseParams,
      userText: "今天天气不错啊,聊聊闲天",
      cfg: makeCfg(),
      vectorStore: store,
      embeddingService: svc,
      session: { mode: "drift", hasAnchor: false, driftThreshold: 0.5 },
    });

    expect(result?.prependContext).toBeUndefined();
    // Anchor is still set — the next same-topic message should hit the drift skip
    expect(result?.sessionUpdate?.decision).toBe("session-first");
    expect(result?.sessionUpdate?.newRecordIds).toEqual([]);
    expect(result?.appendSystemContext).toContain("<memory-tools-guide>");
    expect(searchL1Vector).toHaveBeenCalled();
  });
});

describe("drift mode mid-session", () => {
  it("same-topic turn skips recall entirely (no store search)", async () => {
    const { store, searchL1Vector } = makeStore({ vecResults: [makeL1Hit({ record_id: "m_1", score: 0.9 })] });
    const { svc, embed } = makeEmbedder({ "继续优化数据库": [1, 0] });

    const result = await performAutoRecall({
      ...baseParams,
      userText: "继续优化数据库索引",
      cfg: makeCfg(),
      vectorStore: store,
      embeddingService: svc,
      session: { mode: "drift", hasAnchor: true, anchorEmbedding: [1, 0], anchorText: "帮我优化数据库 schema", driftThreshold: 0.5 },
    });

    expect(result?.recallStrategy).toBe("session-stable");
    expect(result?.prependContext).toBeUndefined();
    expect(result?.sessionUpdate).toBeUndefined();
    // Drift check embeds once, but the store is never searched
    expect(embed).toHaveBeenCalledTimes(1);
    expect(searchL1Vector).not.toHaveBeenCalled();
    expect(result?.appendSystemContext).toContain("<memory-tools-guide>");
  });

  it("topic switch re-primes with a new anchor and injects only new records", async () => {
    const { store, searchL1Vector } = makeStore({
      vecResults: [
        makeL1Hit({ record_id: "m_old", content: "旧主题记忆", score: 0.95 }),
        makeL1Hit({ record_id: "m_new", content: "新主题记忆", score: 0.85 }),
      ],
    });
    const { svc, embed } = makeEmbedder({ "改一下前端页面": [0, 1] });

    const result = await performAutoRecall({
      ...baseParams,
      userText: "改一下前端页面的样式",
      cfg: makeCfg(),
      vectorStore: store,
      embeddingService: svc,
      session: {
        mode: "drift",
        hasAnchor: true,
        anchorEmbedding: [1, 0],
        anchorText: "帮我优化数据库 schema",
        driftThreshold: 0.5,
        excludeRecordIds: ["m_old"],
      },
    });

    expect(result?.recallStrategy).toBe("drift-recall");
    expect(result?.prependContext).toContain("m_new");
    expect(result?.prependContext).not.toContain("m_old");
    expect(result?.sessionUpdate?.decision).toBe("drift-recall");
    expect(result?.sessionUpdate?.anchorEmbedding).toEqual([0, 1]);
    expect(result?.sessionUpdate?.newRecordIds).toEqual(["m_new"]);
    // One embed for the drift check, reused by the search (no second call)
    expect(embed).toHaveBeenCalledTimes(1);
    expect(searchL1Vector).toHaveBeenCalled();
  });

  it("drift-check embed failure fails safe: skip recall, never inject", async () => {
    const embed = vi.fn(async () => { throw new Error("embed down"); });
    const { store, searchL1Vector } = makeStore({ vecResults: [makeL1Hit({ record_id: "m_1", score: 0.9 })] });

    const result = await performAutoRecall({
      ...baseParams,
      userText: "随便什么任务消息内容",
      cfg: makeCfg(),
      vectorStore: store,
      embeddingService: { embed } as unknown as EmbeddingService,
      session: { mode: "drift", hasAnchor: true, anchorEmbedding: [1, 0], anchorText: "旧任务", driftThreshold: 0.5 },
    });

    expect(result?.recallStrategy).toBe("session-stable");
    expect(result?.prependContext).toBeUndefined();
    expect(result?.sessionUpdate).toBeUndefined();
    expect(searchL1Vector).not.toHaveBeenCalled();
  });

  it("bigram fallback detects drift when no embedding service is configured", async () => {
    const { store } = makeStore({ vecResults: [makeL1Hit({ record_id: "m_1", score: 0.9 })] });

    // Anchor text shares almost no bigrams with the message → below 0.22 → drift
    const result = await performAutoRecall({
      ...baseParams,
      userText: "complete unrelated english sentence",
      cfg: makeCfg({ strategy: "keyword" }),
      vectorStore: store,
      session: { mode: "drift", hasAnchor: true, anchorText: "帮我看一下数据库备份策略", driftThreshold: 0.5 },
    });

    expect(result?.recallStrategy).toBe("drift-recall");
    expect(result?.sessionUpdate?.decision).toBe("drift-recall");
  });
});

describe("first-turn mode", () => {
  it("never re-recalls after priming, without any embed call", async () => {
    const { store, searchL1Vector } = makeStore({ vecResults: [makeL1Hit({ record_id: "m_1", score: 0.9 })] });
    const { svc, embed } = makeEmbedder({});

    const result = await performAutoRecall({
      ...baseParams,
      userText: "继续刚才的任务",
      cfg: makeCfg(),
      vectorStore: store,
      embeddingService: svc,
      session: { mode: "first-turn", hasAnchor: true, anchorText: "旧任务", driftThreshold: 0.5 },
    });

    expect(result?.recallStrategy).toBe("session-stable");
    expect(result?.prependContext).toBeUndefined();
    expect(embed).not.toHaveBeenCalled();
    expect(searchL1Vector).not.toHaveBeenCalled();
  });
});

describe("legacy every-turn behavior is untouched", () => {
  it("no session param → per-turn recall with strategy label and no sessionUpdate", async () => {
    const { store } = makeStore({ vecResults: [makeL1Hit({ record_id: "m_1", score: 0.9 })] });
    const { svc } = makeEmbedder({});

    const result = await performAutoRecall({ ...baseParams, cfg: makeCfg(), vectorStore: store, embeddingService: svc });

    expect(result?.recallStrategy).toBe("hybrid");
    expect(result?.prependContext).toContain("m_1");
    expect(result?.sessionUpdate).toBeUndefined();
    expect(result?.appendSystemContext).toContain("<memory-tools-guide>");
    expect(result?.appendSystemContext).not.toContain("<active-scenes>");
  });
});

describe("sceneInjection", () => {
  it("ambient injects <active-scenes> from the scene index (legacy rollback)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "recall-scene-"));
    await fs.mkdir(path.join(dir, ".metadata"), { recursive: true });
    await fs.writeFile(
      path.join(dir, ".metadata", "scene_index.json"),
      JSON.stringify([
        {
          filename: "scene-a.md",
          title: "数据库优化",
          summary: "正在优化 schema",
          created: "2026-08-01T00:00:00.000Z",
          updated: "2026-08-20T00:00:00.000Z",
          first_active: "2026-08-01T00:00:00.000Z",
          last_active: "2026-08-20T00:00:00.000Z",
          memory_count: 12,
        },
      ]),
      "utf-8",
    );

    const { store } = makeStore({ vecResults: [] });
    const { svc } = makeEmbedder({});

    const result = await performAutoRecall({
      ...baseParams,
      pluginDataDir: dir,
      cfg: makeCfg({ sceneInjection: "ambient" }),
      vectorStore: store,
      embeddingService: svc,
    });

    expect(result?.appendSystemContext).toContain("<active-scenes>");
    expect(result?.appendSystemContext).toContain("数据库优化");
    await fs.rm(dir, { recursive: true, force: true });
  });
});

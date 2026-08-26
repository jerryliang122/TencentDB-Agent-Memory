import { describe, expect, it } from "vitest";
import { performAutoRecall } from "./auto-recall.js";
import type { IMemoryStore, L1SearchResult, L1FtsResult } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { MemoryTdaiConfig } from "../../config.js";

/**
 * Tests for the recall threshold filter across all 3 search paths:
 *   - hybrid (RRF merge): candidates pre-filtered by original score before merge
 *   - keyword (FTS5): small-docset escape hatch now uses `threshold * 0.5` floor
 *   - TCVDB native hybrid: client-side threshold backstop
 *
 * Strategy: mock vectorStore + embeddingService, assert that candidates with
 * score < threshold never make it into the final injected lines.
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

function makeStore(opts: {
  vecResults?: L1SearchResult[];
  ftsResults?: L1FtsResult[];
  hybridResults?: L1SearchResult[];
  nativeHybrid?: boolean;
  ftsAvailable?: boolean;
}): IMemoryStore {
  const base = {
    supportsDeferredEmbedding: false,
    init: () => ({ ok: true, ftsAvailable: opts.ftsAvailable ?? true }),
    isDegraded: () => false,
    getCapabilities: () => ({
      nativeHybridSearch: opts.nativeHybrid ?? false,
      supportsDeferredEmbedding: false,
      bm25Local: false,
    }),
    close: () => {},
    upsertL1: () => true,
    deleteL1: () => true,
    deleteL1Batch: () => true,
    deleteL1Expired: () => 0,
    countL1: () => 0,
    queryL1Records: () => [],
    getAllL1Texts: () => [],
    getL1ById: () => null,
    searchL1Vector: () => opts.vecResults ?? [],
    searchL1Fts: () => opts.ftsResults ?? [],
    upsertL0: () => true,
    deleteL0: () => true,
    deleteL0Expired: () => 0,
    countL0: () => 0,
    queryL0ForL1: () => [],
    queryL0GroupedBySession: () => [],
    getAllL0Texts: () => [],
    searchL0Vector: () => [],
    searchL0Fts: () => [],
    reindexAll: async () => ({ l1Count: 0, l0Count: 0 }),
    isFtsAvailable: () => opts.ftsAvailable ?? true,
  };
  if (opts.nativeHybrid) {
    return {
      ...base,
      searchL1Hybrid: (() => Promise.resolve(opts.hybridResults ?? [])) as IMemoryStore["searchL1Hybrid"],
    } as unknown as IMemoryStore;
  }
  return base as unknown as IMemoryStore;
}

function makeEmbedder(): EmbeddingService {
  return {
    embed: async () => new Float32Array(8).fill(0),
  } as unknown as EmbeddingService;
}

function makeCfg(recallOverrides: Partial<MemoryTdaiConfig["recall"]> = {}): MemoryTdaiConfig {
  return {
    recall: {
      enabled: true,
      maxResults: 5,
      maxCharsPerMemory: 0,
      maxTotalRecallChars: 0,
      scoreThreshold: 0.3,
      minQueryChars: 6,
      strategy: "hybrid",
      timeoutMs: 5000,
      subjectOnly: true,
      subjectHintChars: 60,
      persistToTranscript: true,
      ...recallOverrides,
    },
  } as unknown as MemoryTdaiConfig;
}

describe("performAutoRecall - scoreThreshold filter (hybrid path)", () => {
  it("returns no memories when both FTS and embedding scores are below threshold", async () => {
    // Default threshold=0.3, all candidates score=0.1 → all filtered out
    const store = makeStore({
      vecResults: [makeL1Hit({ record_id: "m_v1", score: 0.1 })],
      ftsResults: [makeFtsHit({ record_id: "m_f1", score: 0.1 })],
      ftsAvailable: true,
    });
    const result = await performAutoRecall({
      userText: "请帮我查询项目进度",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "hybrid" }),
      pluginDataDir: "/nonexistent",
      vectorStore: store,
      embeddingService: makeEmbedder(),
    });
    // No scenes file → undefined
    expect(result).toBeUndefined();
  });

  it("preserves FTS-passing candidates when embedding candidates all fail threshold", async () => {
    // FTS score 0.5 passes default threshold 0.3; embedding score 0.1 fails
    const store = makeStore({
      vecResults: [makeL1Hit({ record_id: "m_v_low", score: 0.1 })],
      ftsResults: [makeFtsHit({ record_id: "m_f_pass", content: "fts hit", score: 0.5 })],
      ftsAvailable: true,
    });
    const result = await performAutoRecall({
      userText: "请帮我查询项目进度",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "hybrid" }),
      pluginDataDir: "/nonexistent",
      vectorStore: store,
      embeddingService: makeEmbedder(),
    });
    // Should inject exactly 1 memory (the FTS-passing one), not 2
    expect(result?.prependContext).toBeDefined();
    expect(result!.prependContext!).toContain("m_f_pass");
    expect(result!.prependContext!).not.toContain("m_v_low");
  });

  it("preserves embedding-passing candidates when FTS candidates all fail threshold", async () => {
    const store = makeStore({
      vecResults: [makeL1Hit({ record_id: "m_v_pass", content: "vec hit", score: 0.6 })],
      ftsResults: [makeFtsHit({ record_id: "m_f_low", score: 0.1 })],
      ftsAvailable: true,
    });
    const result = await performAutoRecall({
      userText: "请帮我查询项目进度",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "hybrid" }),
      pluginDataDir: "/nonexistent",
      vectorStore: store,
      embeddingService: makeEmbedder(),
    });
    expect(result?.prependContext).toBeDefined();
    expect(result!.prependContext!).toContain("m_v_pass");
    expect(result!.prependContext!).not.toContain("m_f_low");
  });

  it("dedupes when the same record_id passes both paths (RRF merge keeps one)", async () => {
    // Same record_id m_dup, both score above threshold
    const store = makeStore({
      vecResults: [makeL1Hit({ record_id: "m_dup", content: "shared hit", score: 0.7 })],
      ftsResults: [makeFtsHit({ record_id: "m_dup", content: "shared hit", score: 0.6 })],
      ftsAvailable: true,
    });
    const result = await performAutoRecall({
      userText: "请帮我查询项目进度",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "hybrid" }),
      pluginDataDir: "/nonexistent",
      vectorStore: store,
      embeddingService: makeEmbedder(),
    });
    expect(result?.prependContext).toBeDefined();
    // Should appear exactly once in injected context
    const occurrences = (result!.prependContext!.match(/m_dup/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("threshold=0 disables filtering (boundary case)", async () => {
    // All scores 0.1 but threshold=0 → all pass
    const store = makeStore({
      vecResults: [
        makeL1Hit({ record_id: "m_v1", content: "low score 1", score: 0.1 }),
        makeL1Hit({ record_id: "m_v2", content: "low score 2", score: 0.05 }),
      ],
      ftsResults: [],
      ftsAvailable: true,
    });
    const result = await performAutoRecall({
      userText: "请帮我查询项目进度",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "hybrid", scoreThreshold: 0 }),
      pluginDataDir: "/nonexistent",
      vectorStore: store,
      embeddingService: makeEmbedder(),
    });
    expect(result?.prependContext).toBeDefined();
    expect(result!.prependContext!).toContain("m_v1");
    expect(result!.prependContext!).toContain("m_v2");
  });
});

describe("performAutoRecall - scoreThreshold filter (keyword path)", () => {
  it("small-docset escape hatch: filters out candidates below loose threshold", async () => {
    // maxResults=5 default; ftsResults.length=3 (small docset) but all scores
    // below loose threshold (0.3 * 0.5 = 0.15) → escape hatch returns empty
    const store = makeStore({
      ftsResults: [
        makeFtsHit({ record_id: "m_f1", score: 0.05 }),
        makeFtsHit({ record_id: "m_f2", score: 0.10 }),
        makeFtsHit({ record_id: "m_f3", score: 0.14 }), // below 0.15
      ],
      ftsAvailable: true,
    });
    const result = await performAutoRecall({
      userText: "请帮我查询项目进度",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "keyword" }),
      pluginDataDir: "/nonexistent",
      vectorStore: store,
      embeddingService: makeEmbedder(),
    });
    expect(result).toBeUndefined();
  });

  it("small-docset escape hatch: returns candidates above loose threshold", async () => {
    // Mixed: 1 above loose (0.15), 1 below; only the one above should be returned
    const store = makeStore({
      ftsResults: [
        makeFtsHit({ record_id: "m_pass", content: "pass the loose floor", score: 0.20 }),
        makeFtsHit({ record_id: "m_fail", content: "below loose floor", score: 0.05 }),
      ],
      ftsAvailable: true,
    });
    const result = await performAutoRecall({
      userText: "请帮我查询项目进度",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "keyword" }),
      pluginDataDir: "/nonexistent",
      vectorStore: store,
      embeddingService: makeEmbedder(),
    });
    expect(result?.prependContext).toBeDefined();
    expect(result!.prependContext!).toContain("m_pass");
    expect(result!.prependContext!).not.toContain("m_fail");
  });

  it("large docset (above maxResults) does not trigger escape hatch; strict threshold applies", async () => {
    // 6 FTS hits (> maxResults=5) — escape hatch disabled, strict 0.3 applies.
    // All scores below 0.3 → all filtered out by main path (not escape hatch).
    const store = makeStore({
      ftsResults: Array.from({ length: 6 }, (_, i) =>
        makeFtsHit({ record_id: `m_f${i}`, score: 0.20 }),
      ),
      ftsAvailable: true,
    });
    const result = await performAutoRecall({
      userText: "请帮我查询项目进度",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "keyword" }),
      pluginDataDir: "/nonexistent",
      vectorStore: store,
      embeddingService: makeEmbedder(),
    });
    expect(result).toBeUndefined();
  });
});

describe("performAutoRecall - scoreThreshold filter (TCVDB native hybrid path)", () => {
  it("filters out server-returned candidates below threshold", async () => {
    // Native hybrid returns 5 results all below default 0.3 -> client backstop filters all
    const store = makeStore({
      nativeHybrid: true,
      hybridResults: Array.from({ length: 5 }, (_, i) =>
        makeL1Hit({ record_id: `m_n${i}`, score: 0.20 }),
      ),
      ftsAvailable: true,
    });
    const result = await performAutoRecall({
      userText: "请帮我查询项目进度",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "hybrid" }),
      pluginDataDir: "/nonexistent",
      vectorStore: store,
      embeddingService: makeEmbedder(),
    });
    expect(result).toBeUndefined();
  });

  it("returns only server-returned candidates above threshold", async () => {
    // 5 results, 2 above 0.3, 3 below -> only the 2 above injected
    const store = makeStore({
      nativeHybrid: true,
      hybridResults: [
        makeL1Hit({ record_id: "m_pass1", content: "pass 1", score: 0.55 }),
        makeL1Hit({ record_id: "m_pass2", content: "pass 2", score: 0.45 }),
        makeL1Hit({ record_id: "m_fail1", content: "fail 1", score: 0.25 }),
        makeL1Hit({ record_id: "m_fail2", content: "fail 2", score: 0.20 }),
        makeL1Hit({ record_id: "m_fail3", content: "fail 3", score: 0.10 }),
      ],
      ftsAvailable: true,
    });
    const result = await performAutoRecall({
      userText: "请帮我查询项目进度",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "hybrid" }),
      pluginDataDir: "/nonexistent",
      vectorStore: store,
      embeddingService: makeEmbedder(),
    });
    expect(result?.prependContext).toBeDefined();
    expect(result!.prependContext!).toContain("m_pass1");
    expect(result!.prependContext!).toContain("m_pass2");
    expect(result!.prependContext!).not.toContain("m_fail1");
    expect(result!.prependContext!).not.toContain("m_fail2");
    expect(result!.prependContext!).not.toContain("m_fail3");
  });
});

describe("performAutoRecall - scoreThreshold filter (embedding-only regression)", () => {
  it("pure embedding strategy already filters by threshold (regression)", async () => {
    // 3 candidates: 1 above 0.3, 2 below - only the above one injected
    const store = makeStore({
      vecResults: [
        makeL1Hit({ record_id: "m_pass", content: "pass", score: 0.55 }),
        makeL1Hit({ record_id: "m_low1", content: "low 1", score: 0.25 }),
        makeL1Hit({ record_id: "m_low2", content: "low 2", score: 0.10 }),
      ],
      ftsAvailable: false,
    });
    const result = await performAutoRecall({
      userText: "请帮我查询项目进度",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "embedding" }),
      pluginDataDir: "/nonexistent",
      vectorStore: store,
      embeddingService: makeEmbedder(),
    });
    expect(result?.prependContext).toBeDefined();
    expect(result!.prependContext!).toContain("m_pass");
    expect(result!.prependContext!).not.toContain("m_low1");
    expect(result!.prependContext!).not.toContain("m_low2");
  });

  it("pure embedding strategy returns undefined when all candidates below threshold (regression)", async () => {
    const store = makeStore({
      vecResults: [
        makeL1Hit({ record_id: "m_low1", score: 0.25 }),
        makeL1Hit({ record_id: "m_low2", score: 0.10 }),
      ],
      ftsAvailable: false,
    });
    const result = await performAutoRecall({
      userText: "请帮我查询项目进度",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "embedding" }),
      pluginDataDir: "/nonexistent",
      vectorStore: store,
      embeddingService: makeEmbedder(),
    });
    expect(result).toBeUndefined();
  });
});

describe("performAutoRecall - FTS/cosine threshold decoupling (BGE-M3 calibration)", () => {
  it("a tight cosine threshold does not over-filter the FTS path", async () => {
    // scoreThreshold 0.65 (precise cosine band) kills the 0.5 embedding hit,
    // but the FTS hit at 0.4 passes via the default ftsScoreThreshold 0.35 —
    // the two scales are independent.
    const store = makeStore({
      vecResults: [makeL1Hit({ record_id: "m_vec", content: "vec hit", score: 0.5 })],
      ftsResults: [makeFtsHit({ record_id: "m_fts", content: "fts hit", score: 0.4 })],
      ftsAvailable: true,
    });
    const result = await performAutoRecall({
      userText: "请帮我查询项目进度",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "hybrid", scoreThreshold: 0.65 }),
      pluginDataDir: "/nonexistent",
      vectorStore: store,
      embeddingService: makeEmbedder(),
    });
    expect(result?.prependContext).toBeDefined();
    expect(result!.prependContext!).toContain("m_fts");
    expect(result!.prependContext!).not.toContain("m_vec");
  });

  it("ftsScoreThreshold can be tightened independently of scoreThreshold", async () => {
    // 6 FTS hits (> maxResults) → strict path, no small-docset escape hatch.
    // All scores 0.4 < tightened ftsScoreThreshold 0.45 → filtered out,
    // even though scoreThreshold (cosine, unused on keyword path) is 0.5.
    const store = makeStore({
      ftsResults: Array.from({ length: 6 }, (_, i) =>
        makeFtsHit({ record_id: `m_f${i}`, score: 0.4 }),
      ),
      ftsAvailable: true,
    });
    const result = await performAutoRecall({
      userText: "请帮我查询项目进度",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "keyword", scoreThreshold: 0.5, ftsScoreThreshold: 0.45 }),
      pluginDataDir: "/nonexistent",
      vectorStore: store,
      embeddingService: makeEmbedder(),
    });
    expect(result).toBeUndefined();
  });
});

describe("parseConfig BGE-M3 calibrated defaults", () => {
  it("defaults to empirically calibrated thresholds", async () => {
    const { parseConfig } = await import("../../config.js");
    const cfg = parseConfig(undefined);
    expect(cfg.recall.scoreThreshold).toBe(0.55);
    expect(cfg.recall.ftsScoreThreshold).toBe(0.35);
    expect(cfg.scene.sceneRoutingThreshold).toBe(0.55);
  });
});

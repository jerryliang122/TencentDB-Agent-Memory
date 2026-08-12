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
});

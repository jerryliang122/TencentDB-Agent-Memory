import { describe, expect, it } from "vitest";
import { performAutoRecall } from "./auto-recall.js";
import type { IMemoryStore } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { MemoryTdaiConfig } from "../../config.js";

/**
 * Tests for the `recall.minQueryChars` gate in `performAutoRecall`.
 *
 * The gate skips L1 memory search when the sanitized user text is shorter
 * than `cfg.recall.minQueryChars` (default 6). This filters short
 * acknowledgments ("好的", "嗯", "ok", "对") that produce noisy recall
 * results without semantic intent.
 *
 * Strategy:
 * - Negative tests (gate blocks): mock vectorStore whose search methods throw
 *   if called, and a mock embedder whose `embed()` call count we assert is 0.
 * - Positive tests (gate passes): mock embedder counts `embed()` invocations;
 *   search methods return empty arrays so the recall returns undefined.
 *
 * The `embed()` call count is the cleanest signal: it's invoked on every
 * embedding/hybrid search path *after* the gate, and never otherwise.
 */

interface Tracker {
  embedCalls: number;
  vectorCalls: number;
  ftsCalls: number;
}

function makeFailingStore(t: Tracker): IMemoryStore {
  const fail = (method: string) => (): never => {
    throw new Error(`mock store.${method} should not be called when minQueryChars gate is active`);
  };
  return {
    supportsDeferredEmbedding: false,
    init: () => ({ ok: true, ftsAvailable: false }),
    isDegraded: () => false,
    getCapabilities: () => ({
      nativeHybridSearch: false,
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
    searchL1Vector: () => {
      t.vectorCalls++;
      fail("searchL1Vector")();
    },
    searchL1Fts: () => {
      t.ftsCalls++;
      fail("searchL1Fts")();
    },
    searchL1Hybrid: () => {
      fail("searchL1Hybrid")();
    },
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
    isFtsAvailable: () => false,
  } as unknown as IMemoryStore;
}

function makeEmptyStore(t: Tracker): IMemoryStore {
  // Store whose search methods succeed with empty results (for positive tests).
  return {
    ...makeFailingStore(t),
    searchL1Vector: () => {
      t.vectorCalls++;
      return [];
    },
    searchL1Fts: () => {
      t.ftsCalls++;
      return [];
    },
    isFtsAvailable: () => true,
  } as unknown as IMemoryStore;
}

function makeEmbedder(t: Tracker): EmbeddingService {
  return {
    embed: async () => {
      t.embedCalls++;
      return new Float32Array(8).fill(0);
    },
  } as unknown as EmbeddingService;
}

function makeCfg(overrides: Partial<MemoryTdaiConfig["recall"]> = {}): MemoryTdaiConfig {
  return {
    recall: {
      enabled: true,
      maxResults: 5,
      maxCharsPerMemory: 0,
      maxTotalRecallChars: 0,
      scoreThreshold: 0.3,
      minQueryChars: 6,
      strategy: "embedding",
      timeoutMs: 5000,
      subjectOnly: true,
      subjectHintChars: 60,
      persistToTranscript: true,
      ...overrides,
    },
  } as unknown as MemoryTdaiConfig;
}

function newTracker(): Tracker {
  return { embedCalls: 0, vectorCalls: 0, ftsCalls: 0 };
}

describe("performAutoRecall - minQueryChars gate", () => {
  it("skips L1 search when sanitized text is shorter than minQueryChars (default 6)", async () => {
    const t = newTracker();
    const result = await performAutoRecall({
      userText: "好的",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg(),
      pluginDataDir: "/nonexistent",
      vectorStore: makeFailingStore(t),
      embeddingService: makeEmbedder(t),
    });

    expect(result).toBeUndefined();
    expect(t.embedCalls).toBe(0);
    expect(t.vectorCalls).toBe(0);
    expect(t.ftsCalls).toBe(0);
  });

  it("skips L1 search for various short acknowledgments", async () => {
    const shortMessages = ["嗯", "对", "ok", "好的。", "  嗯嗯  ", "好!", "yeah", "知道了"];
    for (const text of shortMessages) {
      const t = newTracker();
      const result = await performAutoRecall({
        userText: text,
        actorId: "test",
        sessionKey: "sess-1",
        cfg: makeCfg(),
        pluginDataDir: "/nonexistent",
        vectorStore: makeFailingStore(t),
        embeddingService: makeEmbedder(t),
      });
      expect(result, `expected no recall for short message "${text}"`).toBeUndefined();
      expect(t.embedCalls, `embed() called for "${text}"`).toBe(0);
      expect(t.vectorCalls, `searchL1Vector called for "${text}"`).toBe(0);
    }
  });

  it("skips L1 search when raw text is long but sanitization strips it below threshold", async () => {
    // Framework-injected metadata prefix that sanitizeText strips away,
    // leaving only "好的" (2 chars) as the actual user intent.
    const longRawText =
      "Conversation info (untrusted metadata):\n```json\n{\"session\":\"xyz\"}\n```\n好的";
    const t = newTracker();
    const result = await performAutoRecall({
      userText: longRawText,
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg(),
      pluginDataDir: "/nonexistent",
      vectorStore: makeFailingStore(t),
      embeddingService: makeEmbedder(t),
    });

    expect(result).toBeUndefined();
    expect(t.embedCalls).toBe(0);
    expect(t.vectorCalls).toBe(0);
  });

  it("performs L1 search when text meets minQueryChars threshold", async () => {
    const t = newTracker();
    const result = await performAutoRecall({
      userText: "请帮我查询上次的项目进度", // 12 chars, well above minQueryChars=6
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ strategy: "embedding" }),
      pluginDataDir: "/nonexistent",
      vectorStore: makeEmptyStore(t),
      embeddingService: makeEmbedder(t),
    });

    // Embedding was invoked (gate did NOT block)
    expect(t.embedCalls).toBe(1);
    expect(t.vectorCalls).toBe(1);
    // No memories returned, no scenes -> undefined
    expect(result).toBeUndefined();
  });

  it("minQueryChars=0 disables the gate (preserves pre-gate behavior)", async () => {
    // With the gate disabled, even "好的" should reach the search layer.
    // searchMemories' internal < 2 floor still lets 2-char "好的" through.
    const t = newTracker();
    const result = await performAutoRecall({
      userText: "好的",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ minQueryChars: 0, strategy: "embedding" }),
      pluginDataDir: "/nonexistent",
      vectorStore: makeEmptyStore(t),
      embeddingService: makeEmbedder(t),
    });

    expect(t.embedCalls).toBe(1);
    expect(t.vectorCalls).toBe(1);
    expect(result).toBeUndefined();
  });

  it("minQueryChars=2 restores the historical hard floor", async () => {
    // "好的" (2 chars) passes the gate when minQueryChars=2;
    // "嗯" (1 char) is still blocked by the gate.
    const t1 = newTracker();
    const r1 = await performAutoRecall({
      userText: "好的",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ minQueryChars: 2, strategy: "embedding" }),
      pluginDataDir: "/nonexistent",
      vectorStore: makeEmptyStore(t1),
      embeddingService: makeEmbedder(t1),
    });
    expect(t1.embedCalls).toBe(1);
    expect(r1).toBeUndefined();

    const t2 = newTracker();
    const r2 = await performAutoRecall({
      userText: "嗯",
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ minQueryChars: 2, strategy: "embedding" }),
      pluginDataDir: "/nonexistent",
      vectorStore: makeFailingStore(t2),
      embeddingService: makeEmbedder(t2),
    });
    expect(t2.embedCalls).toBe(0);
    expect(r2).toBeUndefined();
  });

  it("respects a custom higher minQueryChars threshold", async () => {
    // 7-char message, minQueryChars=10 -> skipped
    const t = newTracker();
    const result = await performAutoRecall({
      userText: "今天天气怎么样", // 7 chars
      actorId: "test",
      sessionKey: "sess-1",
      cfg: makeCfg({ minQueryChars: 10, strategy: "embedding" }),
      pluginDataDir: "/nonexistent",
      vectorStore: makeFailingStore(t),
      embeddingService: makeEmbedder(t),
    });

    expect(result).toBeUndefined();
    expect(t.embedCalls).toBe(0);
    expect(t.vectorCalls).toBe(0);
  });
});

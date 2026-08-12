/**
 * auto-recall hook (v3): injects relevant memories + active scenes into agent context
 * before the agent starts processing.
 *
 * - Searches L1 memories using configurable strategy (keyword / embedding / hybrid)
 *   - keyword: FTS5 BM25 (requires FTS5; returns empty if unavailable)
 *   - embedding: VectorStore cosine similarity
 *   - hybrid: keyword + embedding merged with RRF
 * - L3 active scenes (top-K most-recently-updated summaries)
 */

import { formatForLLM } from "../../utils/time.js";
import type { MemoryTdaiConfig } from "../../config.js";
import { readSceneIndex } from "../scene/scene-index.js";
import { generateActiveScenes } from "../scene/scene-navigation.js";
import type { MemoryRecord } from "../record/l1-reader.js";
import type { IMemoryStore, L1SearchResult, L1FtsResult } from "../store/types.js";
import { buildFtsQuery } from "../store/sqlite.js";
import type { EmbeddingService, EmbeddingCallOptions } from "../store/embedding.js";
import { sanitizeText } from "../../utils/sanitize.js";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai] [recall]";
const RECALL_TRUNCATION_SUFFIX = "…（已截断；可用 tdai_memory_search 或 tdai_conversation_search 查看详情）";
const MIN_TRUNCATED_RECALL_LINE_CHARS = 40;
const RECALL_LINE_SEPARATOR = "\n";

/**
 * Memory tools usage guide — injected at the end of memory context so the
 * main agent knows how to actively retrieve deeper information.
 */
const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## 记忆工具调用指南

上方注入的记忆片段采用了"主题 + 内容首段提示 + record_id"的紧凑格式（默认 60 字提示），用于最小化上下文占用。当某条记忆的提示看起来相关、需要完整正文才能回答时，按下方优先级调用工具取回原文。

可用工具（按推荐优先级）：

- **tdai_memory_get**：按 record_id 取回单条记忆的完整正文（推荐首选）。
  适用于"上方 <relevant-memories> 中某条标了 [id=m_xxx] 的记忆看起来相关"的场景。
  参数：record_id（取自 [id=...] 标记）。
- **tdai_memory_search**：搜索结构化记忆（L1）。
  适用于回忆用户偏好、历史事件节点、规则等关键信息，或当上方未注入相关主题但你觉得应该存在时。
  参数：query（关键词或自然语言描述）、可选 limit/type/scene 过滤。
- **tdai_conversation_search**：搜索原始对话（L0）。
  适用于查找具体消息原文、时间线、上下文细节；也可用于补充或校验 memory_search 的结果。
- **read_file**（scene_blocks/<title>.md）：当上方 <active-scenes> 中某场景看起来相关、需要完整画像、事件经过或阶段结论时使用。按场景标题构造路径：scene_blocks/<title>.md

### ⚠️ 调用次数限制
每轮对话中，tdai_memory_get / tdai_memory_search / tdai_conversation_search **合计最多调用 5 次**。
- 推荐流程：先用 tdai_memory_get 取回注入过的记忆（命中率高、成本低），再用 tdai_memory_search 寻找新记忆。
- 首次搜索无结果时，可换关键词或换工具重试，但总调用次数不要超过 5 次。
- 若 5 次后仍无结果，说明该信息不在记忆中，请直接根据已有信息回复用户，不要继续搜索。
</memory-tools-guide>`

/** A single recalled L1 memory with its search score and type. */
export interface RecalledMemory {
  content: string;
  score: number;
  type: string;
}

export interface RecallResult {
  /** L1 relevant memories — prepended to user prompt text (dynamic, per-turn) */
  prependContext?: string;
  /** Stable recall context appended to system prompt (active scenes, tools guide — cacheable) */
  appendSystemContext?: string;

  // ── Metric payload (for pendingRecallCache in index.ts) ──
  /** L1 memories that were recalled (with scores), for metric reporting */
  recalledL1Memories?: RecalledMemory[];
  /** @deprecated L3 persona injection removed in redesign; always null. Field
   *  retained for backward-compat with metric consumers in index.ts. */
  recalledL3Persona?: string | null;
  /** Effective search strategy used */
  recallStrategy?: string;
}

export async function performAutoRecall(params: {
  userText: string;
  actorId: string;
  sessionKey: string;
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
}): Promise<RecallResult | undefined> {
  const { cfg, logger } = params;
  const timeoutMs = cfg.recall.timeoutMs ?? 5000;

  let timer: ReturnType<typeof setTimeout> | undefined;

  return Promise.race([
    performAutoRecallInner(params).finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        logger?.warn?.(
          `${TAG} ⚠️ Recall timed out after ${timeoutMs}ms — skipping memory injection to avoid blocking the user`,
        );
        resolve(undefined);
      }, timeoutMs);
    }),
  ]);
}

async function performAutoRecallInner(params: {
  userText: string;
  actorId: string;
  sessionKey: string;
  cfg: MemoryTdaiConfig;
  pluginDataDir: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
}): Promise<RecallResult | undefined> {
  const { userText, cfg, pluginDataDir, logger, vectorStore, embeddingService } = params;
  const tRecallStart = performance.now();

  // Search relevant memories (L1 layer).
  // Skip L1 search when:
  //   - userText is empty/undefined, OR
  //   - sanitized text is shorter than `cfg.recall.minQueryChars` (default 6).
  // Short acknowledgments ("好的", "嗯", "ok", "对") carry no semantic intent
  // and produce noisy recall results. Active scenes are still injected below
  // (they are stable, cacheable context independent of the user message).
  const tSearchStart = performance.now();
  let memoryLines: string[] = [];
  let effectiveStrategy = "skipped";
  let recalledL1Memories: RecalledMemory[] = [];
  let searchTiming: SearchTiming = { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 };
  if (!userText || userText.length === 0) {
    logger?.debug?.(`${TAG} User text empty/undefined, skipping memory search (scenes still injected)`);
  } else {
    const minQueryChars = cfg.recall.minQueryChars ?? 6;
    const cleanText = sanitizeText(userText);
    if (cleanText.length < minQueryChars) {
      logger?.info?.(
        `${TAG} User text too short for memory search ` +
        `(raw=${userText.length}, clean=${cleanText.length}, minQueryChars=${minQueryChars}), ` +
        `skipping L1 memory search (scenes still injected)`,
      );
      effectiveStrategy = "skipped-short";
    } else {
      effectiveStrategy = cfg.recall.strategy ?? "hybrid";
      const searchResult = await searchMemories(userText, pluginDataDir, cfg, logger, effectiveStrategy as "keyword" | "embedding" | "hybrid", vectorStore, embeddingService);
      memoryLines = searchResult.lines;
      searchTiming = searchResult.timing;
      memoryLines = applyRecallBudget(memoryLines, cfg.recall, logger);

      // Extract structured RecalledMemory from formatted lines for metric reporting
      recalledL1Memories = memoryLines.map((line) => {
        const match = line.match(/^-\s+\[([^\]]+)\]\s+(.+?)(?:\s*\(活动时间:.*\))?$/);
        if (match) {
          const tag = match[1];
          const content = match[2].trim();
          const typePart = tag.includes("|") ? tag.split("|")[0] : tag;
          return { content, score: 0, type: typePart };
        }
        return { content: line, score: 0, type: "unknown" };
      });
    }
  }
  const tSearchEnd = performance.now();

  // L3 persona injection removed in redesign — persona.md auto-generation
  // is disabled. User profile is owned by AGENTS.md / IDENTITY.md / USER.md.
  const tPersonaStart = performance.now();
  const tPersonaEnd = tPersonaStart;

  // Load top-K active scenes (L2/L3 layer — recent activity context)
  const tSceneStart = performance.now();
  let activeScenesText: string | undefined;
  try {
    const sceneIndex = await readSceneIndex(pluginDataDir);
    if (sceneIndex.length > 0) {
      activeScenesText = generateActiveScenes(
        sceneIndex,
        cfg.persona.l3InjectTopK,
        cfg.persona.l3InjectSummaryChars,
      );
      logger?.debug?.(
        `${TAG} Active scenes generated: top-${cfg.persona.l3InjectTopK} of ${sceneIndex.length}`,
      );
    }
  } catch {
    logger?.debug?.(`${TAG} No scene index found`);
  }
  const tSceneEnd = performance.now();

  if (memoryLines.length === 0 && !activeScenesText) {
    const totalMs = performance.now() - tRecallStart;
    logger?.info(
      `${TAG} ⏱ Recall timing: total=${totalMs.toFixed(0)}ms, ` +
      `search=${(tSearchEnd - tSearchStart).toFixed(0)}ms(strategy=${effectiveStrategy},hits=${memoryLines.length},` +
      `fts=${searchTiming.ftsMs.toFixed(0)}ms/${searchTiming.ftsHits}hits,` +
      `vec=${searchTiming.embeddingMs.toFixed(0)}ms/${searchTiming.embeddingHits}hits), ` +
      `scene=${(tSceneEnd - tSceneStart).toFixed(0)}ms — no context to inject`,
    );
    logger?.debug?.(`${TAG} No memories/scenes to inject`);
    return undefined;
  }

  // Split recall context into stable and dynamic parts to optimize prompt caching.
  //
  // appendSystemContext (system prompt end — stable, cacheable):
  //   active scenes, memory tools guide
  //   These change infrequently; when content is identical across turns,
  //   providers with prompt caching (Anthropic/OpenAI) can cache this region.
  //
  // prependContext (user prompt prefix — dynamic, per-turn):
  //   L1 relevant memories — different every turn, moved out of system prompt
  //   so it doesn't bust the system prompt cache.
  const stableParts: string[] = [];
  if (activeScenesText) {
    stableParts.push(`<active-scenes>\n${activeScenesText}\n</active-scenes>`);
  }

  // Dynamic part: L1 relevant memories (changes every turn) → prependContext (user prompt)
  let prependContext: string | undefined;
  if (memoryLines.length > 0) {
    prependContext =
      `<relevant-memories>\n以下是当前对话召回的相关记忆，不代表当前任务进程，仅作为参考：\n\n${memoryLines.join(RECALL_LINE_SEPARATOR)}\n</relevant-memories>`;
  }

  // Append memory tools usage guide to the stable part so the agent knows
  // how to actively retrieve deeper context when the injected snippets
  // are not enough. This is static content and benefits from caching.
  if (stableParts.length > 0 || prependContext) {
    stableParts.push(MEMORY_TOOLS_GUIDE);
  }

  const appendSystemContext = stableParts.length > 0 ? stableParts.join("\n\n") : undefined;

  const totalMs = performance.now() - tRecallStart;
  logger?.info(
    `${TAG} ⏱ Recall timing: total=${totalMs.toFixed(0)}ms, ` +
    `search=${(tSearchEnd - tSearchStart).toFixed(0)}ms(strategy=${effectiveStrategy},hits=${memoryLines.length},` +
    `fts=${searchTiming.ftsMs.toFixed(0)}ms/${searchTiming.ftsHits}hits,` +
    `vec=${searchTiming.embeddingMs.toFixed(0)}ms/${searchTiming.embeddingHits}hits), ` +
    `scene=${(tSceneEnd - tSceneStart).toFixed(0)}ms(${activeScenesText ? "loaded" : "none"})`,
  );

  if (!appendSystemContext && !prependContext) {
    return undefined;
  }

  return {
    prependContext,
    appendSystemContext,
    recalledL1Memories,
    recalledL3Persona: null, // L3 persona disabled in redesign
    recallStrategy: effectiveStrategy,
  };
}

// ============================
// Multi-strategy search dispatcher
// ============================

interface ScoredRecord {
  record: MemoryRecord;
  score: number;
}

/** Timing breakdown from memory search */
interface SearchTiming {
  ftsMs: number;
  embeddingMs: number;
  ftsHits: number;
  embeddingHits: number;
}

interface SearchResult {
  lines: string[];
  timing: SearchTiming;
}

/**
 * Search memories and return both formatted lines and structured details.
 *
 * This is a thin wrapper around `searchMemories` that also captures
 * the recalled memory metadata for metric reporting (agent_turn event).
 * It parses the returned formatted lines to extract type/content info.
 */
async function searchMemoriesWithDetails(
  userText: string,
  pluginDataDir: string,
  cfg: MemoryTdaiConfig,
  logger: Logger | undefined,
  strategy: "keyword" | "embedding" | "hybrid",
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
): Promise<{ lines: string[]; memories: RecalledMemory[]; timing: SearchTiming }> {
  const result = await searchMemories(userText, pluginDataDir, cfg, logger, strategy, vectorStore, embeddingService);

  // Extract structured data from formatted memory lines.
  // Format: "- [type|scene] content (活动时间: ...)" or "- [type] content"
  const memories: RecalledMemory[] = result.lines.map((line) => {
    const match = line.match(/^-\s+\[([^\]]+)\]\s+(.+?)(?:\s*\(活动时间:.*\))?$/);
    if (match) {
      const tag = match[1];
      const content = match[2].trim();
      const typePart = tag.includes("|") ? tag.split("|")[0] : tag;
      return { content, score: 0, type: typePart };
    }
    return { content: line, score: 0, type: "unknown" };
  });

  return { lines: result.lines, memories, timing: result.timing };
}

/**
 * Search memories using the configured strategy.
 *
 * - "keyword": JSONL keyword-based (Jaccard similarity) — no embedding needed
 * - "embedding": VectorStore cosine similarity — requires vectorStore + embeddingService
 * - "hybrid": merge both keyword and embedding results with RRF (Reciprocal Rank Fusion)
 *
 * Falls back to keyword if embedding resources are unavailable.
 */
async function searchMemories(
  userText: string,
  pluginDataDir: string,
  cfg: MemoryTdaiConfig,
  logger: Logger | undefined,
  strategy: "keyword" | "embedding" | "hybrid",
  vectorStore?: IMemoryStore,
  embeddingService?: EmbeddingService,
): Promise<SearchResult> {
  const emptyResult: SearchResult = { lines: [], timing: { ftsMs: 0, embeddingMs: 0, ftsHits: 0, embeddingHits: 0 } };
  // Strip gateway-injected inbound metadata (Sender, timestamps, media markers,
  // base64 image data, etc.) so FTS / embedding queries are based on pure user intent.
  const cleanText = sanitizeText(userText);

  if (cleanText.length < 2) {
    logger?.debug?.(`${TAG} Query too short for memory search (raw=${userText.length}, clean=${cleanText.length})`);
    return emptyResult;
  }

  if (cleanText.length !== userText.length) {
    logger?.debug?.(
      `${TAG} userText sanitized: ${userText.length} → ${cleanText.length} chars`,
    );
  }

  const maxResults = cfg.recall.maxResults ?? 5;
  const threshold = cfg.recall.scoreThreshold ?? 0.3;

  // Build format options from config — drives subject-only injection mode.
  const formatOpts: FormatLineOptions = {
    subjectOnly: cfg.recall.subjectOnly,
    subjectHintChars: cfg.recall.subjectHintChars,
  };

  const embeddingAvailable = !!vectorStore && !!embeddingService;

  logger?.debug?.(
    `${TAG} [searchMemories] strategy=${strategy}, embeddingAvailable=${embeddingAvailable}, ` +
    `vectorStore=${vectorStore ? "available" : "UNAVAILABLE"}, ` +
    `embeddingService=${embeddingService ? "available" : "UNAVAILABLE"}, ` +
    `maxResults=${maxResults}, threshold=${threshold}, ` +
    `formatMode=${formatOpts.subjectOnly ? "subject" : "legacy"}(${formatOpts.subjectHintChars})`,
  );

  // Determine effective strategy (fall back to keyword if embedding not available)
  let effectiveStrategy = strategy;
  if ((strategy === "embedding" || strategy === "hybrid") && !embeddingAvailable) {
    logger?.warn?.(
      `${TAG} Strategy "${strategy}" requested but EmbeddingService not available, falling back to keyword`,
    );
    effectiveStrategy = "keyword";
  }

  logger?.debug?.(`${TAG} Search strategy: ${effectiveStrategy} (configured: ${strategy})`);

  // Resolve per-call embedding timeout for recall path.
  // Falls back to global embedding.timeoutMs when recallTimeoutMs is not configured.
  const recallEmbeddingTimeoutMs = cfg.embedding?.recallTimeoutMs ?? cfg.embedding?.timeoutMs;
  const embeddingCallOpts: EmbeddingCallOptions = { timeoutMs: recallEmbeddingTimeoutMs };

  try {
    if (effectiveStrategy === "keyword") {
      const tFts = performance.now();
      const lines = await searchByKeyword(cleanText, pluginDataDir, maxResults, threshold, logger, vectorStore, formatOpts);
      return { lines, timing: { ftsMs: performance.now() - tFts, embeddingMs: 0, ftsHits: lines.length, embeddingHits: 0 } };
    }

    if (effectiveStrategy === "embedding") {
      const tEmb = performance.now();
      const lines = await searchByEmbedding(cleanText, maxResults, threshold, vectorStore!, embeddingService!, logger, embeddingCallOpts, formatOpts);
      return { lines, timing: { ftsMs: 0, embeddingMs: performance.now() - tEmb, ftsHits: 0, embeddingHits: lines.length } };
    }

    // Hybrid: if the store natively supports hybrid search (e.g. TCVDB does
    // server-side dense + sparse + RRF in a single API call), short-circuit
    // to avoid a redundant second HTTP request and a wasted local embed().
    if (vectorStore?.getCapabilities().nativeHybridSearch) {
      const tNative = performance.now();
      const results = await vectorStore.searchL1Hybrid({ query: cleanText, topK: maxResults });
      const nativeMs = performance.now() - tNative;
      logger?.debug?.(`${TAG} [hybrid-native] Single-call hybrid: ${results.length} results in ${nativeMs.toFixed(0)}ms`);
      const lines = results.map((r) => formatMemoryLine(vectorResultToFormatable(r), formatOpts));
      return { lines, timing: { ftsMs: 0, embeddingMs: nativeMs, ftsHits: 0, embeddingHits: results.length } };
    }

    // Fallback: run keyword + embedding in parallel, merge with client-side RRF (SQLite path)
    return await searchHybrid(cleanText, pluginDataDir, maxResults, threshold, vectorStore!, embeddingService!, logger, embeddingCallOpts, formatOpts);
  } catch (err) {
    logger?.warn?.(`${TAG} Memory search failed (strategy=${effectiveStrategy}): ${err instanceof Error ? err.message : String(err)}`);
    return emptyResult;
  }
}

// ============================
// Strategy: Keyword (FTS5 BM25, no in-memory fallback)
// ============================

async function searchByKeyword(
  userText: string,
  _pluginDataDir: string,
  maxResults: number,
  threshold: number,
  logger?: Logger,
  vectorStore?: IMemoryStore,
  formatOpts?: FormatLineOptions,
): Promise<string[]> {
  // Prefer FTS5 if available
  if (vectorStore?.isFtsAvailable()) {
    const ftsQuery = buildFtsQuery(userText);
    if (ftsQuery) {
      logger?.debug?.(`${TAG} [keyword-fts] Using FTS5 BM25 search: query="${ftsQuery}"`);
      const ftsResults = await vectorStore.searchL1Fts(ftsQuery, maxResults * 2);
      if (ftsResults.length > 0) {
        logger?.debug?.(
          `${TAG} [keyword-fts] FTS5 raw results (${ftsResults.length}): ` +
          ftsResults.map((r) => `id=${r.record_id} score=${r.score.toFixed(6)}`).join(", "),
        );
        const filtered = ftsResults
          .filter((r) => r.score >= threshold)
          .slice(0, maxResults);

        if (filtered.length > 0) {
          logger?.debug?.(`${TAG} [keyword-fts] FTS5 found ${filtered.length} results (from ${ftsResults.length} raw, threshold=${threshold})`);
          return filtered.map((r) => formatMemoryLine(ftsResultToFormatable(r), formatOpts ?? DEFAULT_FORMAT_OPTS));
        }

        // BM25 absolute scores are unreliable when the document set is very
        // small (e.g. 1–3 records) because IDF approaches 0.  In that case,
        // trust FTS5's MATCH + rank ordering and return the top results anyway.
        if (ftsResults.length <= maxResults) {
          logger?.debug?.(
            `${TAG} [keyword-fts] All ${ftsResults.length} results below threshold=${threshold} ` +
            `but document set is small — returning all matched results`,
          );
          return ftsResults.slice(0, maxResults).map((r) => formatMemoryLine(ftsResultToFormatable(r), formatOpts ?? DEFAULT_FORMAT_OPTS));
        }
        logger?.debug?.(`${TAG} [keyword-fts] FTS5 returned 0 results above threshold (from ${ftsResults.length} raw)`);
      }
    }
  }

  // FTS5 not available or returned no results — skip in-memory fallback to avoid O(N) full scan
  logger?.debug?.(`${TAG} [keyword] FTS5 unavailable or no results, skipping keyword search`);
  return [];
}

// ============================
// Strategy: Embedding (VectorStore cosine)
// ============================

/**
 * Default format options used when caller doesn't pass any (e.g. tests,
 * dead-code paths). Defaults to subjectOnly mode with 60-char hint,
 * matching `parseConfig`'s production defaults.
 */
const DEFAULT_FORMAT_OPTS: FormatLineOptions = {
  subjectOnly: true,
  subjectHintChars: 60,
};

async function searchByEmbedding(
  userText: string,
  maxResults: number,
  threshold: number,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  logger?: Logger,
  embeddingCallOpts?: EmbeddingCallOptions,
  formatOpts?: FormatLineOptions,
): Promise<string[]> {
  logger?.debug?.(
    `${TAG} [embedding-search] START query="${userText.slice(0, 80)}...", maxResults=${maxResults}, threshold=${threshold}`,
  );
  const queryEmbedding = await embeddingService.embed(userText, embeddingCallOpts);
  logger?.debug?.(
    `${TAG} [embedding-search] Query embedding OK: dims=${queryEmbedding.length}, ` +
    `norm=${Math.sqrt(Array.from(queryEmbedding).reduce((s, v) => s + v * v, 0)).toFixed(4)}, ` +
    `searching top-${maxResults * 2}...`,
  );
  // Retrieve more candidates for subsequent filtering
  const vecResults: L1SearchResult[] = await vectorStore.searchL1Vector(queryEmbedding, maxResults * 2);

  if (vecResults.length === 0) {
    logger?.debug?.(`${TAG} [embedding-search] Returned 0 results`);
    return [];
  }

  logger?.debug?.(`${TAG} [embedding-search] Got ${vecResults.length} candidates, filtering by threshold=${threshold}`);
  for (const r of vecResults) {
    logger?.debug?.(
      `${TAG} [embedding-search] candidate id=${r.record_id}, score=${r.score.toFixed(4)}, ` +
      `type=${r.type}, content="${r.content.slice(0, 60)}..."`,
    );
  }

  const filtered = vecResults
    .filter((r) => r.score >= threshold)
    .slice(0, maxResults);

  if (filtered.length > 0) {
    logger?.debug?.(`${TAG} [embedding-search] Found ${filtered.length} relevant memories above threshold (from ${vecResults.length} candidates)`);
    return filtered.map((r) => formatMemoryLine(vectorResultToFormatable(r), formatOpts ?? DEFAULT_FORMAT_OPTS));
  }

  logger?.debug?.(`${TAG} [embedding-search] No results above threshold ${threshold}`);
  return [];
}

// ============================
// Strategy: Hybrid (Keyword + Embedding + RRF)
// ============================

/**
 * Hybrid search: run keyword (FTS5) and embedding in parallel, merge with
 * Reciprocal Rank Fusion (RRF) to combine rank lists.
 *
 * RRF score for a record at rank r = 1 / (k + r), where k=60 is a constant.
 * If a record appears in both lists, its RRF scores are summed.
 *
 * If FTS5 is unavailable, the keyword side returns empty and RRF uses
 * embedding results only.
 */
async function searchHybrid(
  userText: string,
  _pluginDataDir: string,
  maxResults: number,
  threshold: number,
  vectorStore: IMemoryStore,
  embeddingService: EmbeddingService,
  logger?: Logger,
  embeddingCallOpts?: EmbeddingCallOptions,
  formatOpts?: FormatLineOptions,
): Promise<SearchResult> {
  // Run keyword and embedding searches in parallel
  const candidateK = maxResults * 3; // retrieve more for merging

  const [keywordResult, embeddingResult] = await Promise.all([
    // Keyword search: FTS5 only (no in-memory fallback)
    (async () => {
      const tStart = performance.now();
      try {
        // Try FTS5 first
        if (vectorStore.isFtsAvailable()) {
          const ftsQuery = buildFtsQuery(userText);
          if (ftsQuery) {
            const ftsResults = await vectorStore.searchL1Fts(ftsQuery, candidateK);
            if (ftsResults.length > 0) {
              logger?.debug?.(`${TAG} [hybrid-keyword-fts] FTS5 found ${ftsResults.length} candidates`);
              // Convert FtsSearchResult to ScoredRecord for RRF merge
              const records = ftsResults
                .filter((r) => r.score >= threshold)
                .map((r): ScoredRecord => ({
                  record: {
                    id: r.record_id,
                    content: r.content,
                    type: r.type as MemoryRecord["type"],
                    priority: r.priority,
                    scene_name: r.scene_name,
                    source_message_ids: [],
                    metadata: r.metadata_json ? (() => { try { return JSON.parse(r.metadata_json); } catch { return {}; } })() : {},
                    timestamps: [r.timestamp_str].filter(Boolean),
                    createdAt: "",
                    updatedAt: "",
                    sessionKey: r.session_key,
                    sessionId: r.session_id,
                  },
                  score: r.score,
                }));
              return { records, ms: performance.now() - tStart };
            }
          }
        }
        // FTS5 not available or returned no results — skip in-memory fallback
        logger?.debug?.(`${TAG} [hybrid-keyword] FTS5 unavailable or no results, skipping keyword part`);
        return { records: [] as ScoredRecord[], ms: performance.now() - tStart };
      } catch (err) {
        logger?.warn?.(`${TAG} Hybrid: keyword part failed: ${err instanceof Error ? err.message : String(err)}`);
        return { records: [] as ScoredRecord[], ms: performance.now() - tStart };
      }
    })(),
    // Embedding search
    (async () => {
      const tStart = performance.now();
      try {
        logger?.debug?.(`${TAG} [hybrid-embedding] Generating query embedding...`);
        const queryEmbedding = await embeddingService.embed(userText, embeddingCallOpts);
        logger?.debug?.(
          `${TAG} [hybrid-embedding] Embedding OK, dims=${queryEmbedding.length}, searching top-${candidateK}...`,
        );
        const rawResults = await vectorStore.searchL1Vector(queryEmbedding, candidateK, userText);
        const results = rawResults.filter((r) => r.score >= threshold);
        logger?.debug?.(
          `${TAG} [hybrid-embedding] Got ${rawResults.length} candidates, ${results.length} after threshold=${threshold} filter`,
        );
        return { results, ms: performance.now() - tStart };
      } catch (err) {
        logger?.warn?.(`${TAG} Hybrid: embedding part failed: ${err instanceof Error ? err.message : String(err)}`);
        return { results: [] as L1SearchResult[], ms: performance.now() - tStart };
      }
    })(),
  ]);

  const keywordResults = keywordResult.records;
  const embeddingResults = embeddingResult.results;
  const timing: SearchTiming = {
    ftsMs: keywordResult.ms,
    embeddingMs: embeddingResult.ms,
    ftsHits: keywordResults.length,
    embeddingHits: embeddingResults.length,
  };

  if (keywordResults.length === 0 && embeddingResults.length === 0) {
    logger?.debug?.(`${TAG} Hybrid search: both strategies returned 0 results`);
    return { lines: [], timing };
  }

  // RRF merge: k=60 is a standard constant from the RRF paper
  const RRF_K = 60;

  // Map: record_id → { rrfScore, formatable }
  const mergedMap = new Map<string, { rrfScore: number; formatable: FormatableMemory }>();

  // Process keyword results
  for (let rank = 0; rank < keywordResults.length; rank++) {
    const r = keywordResults[rank];
    const id = r.record.id;
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = mergedMap.get(id);
    if (existing) {
      existing.rrfScore += rrfScore;
    } else {
      mergedMap.set(id, { rrfScore, formatable: recordToFormatable(r.record) });
    }
  }

  // Process embedding results
  for (let rank = 0; rank < embeddingResults.length; rank++) {
    const r = embeddingResults[rank];
    const id = r.record_id;
    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = mergedMap.get(id);
    if (existing) {
      existing.rrfScore += rrfScore;
    } else {
      mergedMap.set(id, { rrfScore, formatable: vectorResultToFormatable(r) });
    }
  }

  // Sort by combined RRF score and take top results
  const sorted = [...mergedMap.entries()]
    .sort((a, b) => b[1].rrfScore - a[1].rrfScore)
    .slice(0, maxResults);

  if (sorted.length > 0) {
    logger?.debug?.(
      `${TAG} Hybrid search found ${sorted.length} results ` +
      `(keyword=${keywordResults.length}, embedding=${embeddingResults.length})`,
    );
    return { lines: sorted.map(([, { formatable }]) => formatMemoryLine(formatable, formatOpts ?? DEFAULT_FORMAT_OPTS)), timing };
  }

  logger?.debug?.(`${TAG} Hybrid search: no results after merge`);
  return { lines: [], timing };
}

// ============================
// Unified memory line formatter
// ============================

/**
 * Format a single memory record into a rich natural-language line for prompt injection.
 *
 * Two output modes, controlled by `opts.subjectOnly`:
 *
 * **subjectOnly=true** (default in v3): inject only a compact subject line:
 *   - [type|scene_name] <content首N字 + "…"> (活动时间: ...) [id=m_xxx]
 * The main agent fetches full content on demand via `tdai_memory_get(record_id)`.
 * Set `subjectHintChars=0` for pure subject-only mode (no content fragment).
 *
 * **subjectOnly=false** (legacy): inject full content + time:
 *   - [type|scene_name] <full content> (活动时间: ...)
 * Truncation is then the responsibility of `applyRecallBudget`.
 *
 * Time semantics:
 *   - timestamp (点时间): when the activity/event happened, e.g. "2025-03-01 mentioned something"
 *   - activity_start_time / activity_end_time (段时间): activity time range
 *   - All three time fields may be empty/undefined — handled gracefully.
 */
export interface FormatableMemory {
  type: string;
  content: string;
  scene_name?: string;
  /** Activity time range start (段时间 start), may be empty */
  activity_start_time?: string;
  /** Activity time range end (段时间 end), may be empty */
  activity_end_time?: string;
  /** Activity point-in-time (点时间: when it happened), may be empty */
  timestamp?: string;
  /** Unique record ID — appended as `[id=...]` in subjectOnly mode so the
   *  main agent can call `tdai_memory_get(record_id)` to fetch full content. */
  record_id: string;
}

/** Options controlling `formatMemoryLine` output format. */
export interface FormatLineOptions {
  /** When true, emit subject-only mode (compact line + `[id=...]`).
   *  When false, emit legacy full-content line (no `[id=...]` suffix). */
  subjectOnly: boolean;
  /** Content hint length (code points) for subjectOnly mode.
   *  0 = no content fragment (pure subject line).
   *  Default effective value is 60 (set by caller from `cfg.recall.subjectHintChars`). */
  subjectHintChars?: number;
}

export function formatMemoryLine(m: FormatableMemory, opts: FormatLineOptions): string {
  // 1. Type tag + optional scene name
  const tag = m.scene_name ? `${m.type}|${m.scene_name}` : m.type;

  // 2. Time info — prefer activity_start/end range; fall back to timestamp as point-in-time
  const start = formatTimestamp(m.activity_start_time);
  const end = formatTimestamp(m.activity_end_time);
  const point = formatTimestamp(m.timestamp);

  let timeInfo = "";
  if (start && end) {
    timeInfo = ` (活动时间: ${start} ~ ${end})`;
  } else if (start) {
    timeInfo = ` (活动时间: ${start}起)`;
  } else if (end) {
    timeInfo = ` (活动时间: 至${end})`;
  } else if (point) {
    timeInfo = ` (活动时间: ${point})`;
  }

  // 3. Branch on mode
  if (!opts.subjectOnly) {
    // Legacy mode: full content + time, no record_id suffix
    return `- [${tag}] ${m.content}${timeInfo}`;
  }

  // Subject-only mode: hint + record_id suffix
  const hintChars = opts.subjectHintChars ?? 60;
  let hint = "";
  if (hintChars > 0 && m.content) {
    // Normalize newlines to spaces so the bullet stays single-line
    // (production content frequently starts with "首行：\n\n【section】...")
    const normalized = m.content.replace(/\s*\n\s*/g, " ");
    hint = ` ${truncateHint(normalized, hintChars)}`;
  }

  return `- [${tag}]${hint}${timeInfo} [id=${m.record_id}]`;
}

/**
 * Truncate content to `maxChars` code points, appending an ellipsis ("…")
 * when truncation actually happened. When content fits within the budget,
 * returns it unchanged (no ellipsis).
 *
 * The single-char ellipsis replaces the legacy verbose
 * `RECALL_TRUNCATION_SUFFIX` ("…（已截断；可用 tdai_memory_search 查看详情）")
 * because the new subject-only mode is *always* a hint — the suffix would
 * be redundant. (Legacy mode still uses the verbose suffix via
 * `applyRecallBudget` + `truncateRecallLine`.)
 */
function truncateHint(content: string, maxChars: number): string {
  const cps = Array.from(content);
  if (cps.length <= maxChars) return content;
  return `${cps.slice(0, maxChars).join("").trimEnd()}…`;
}

function applyRecallBudget(
  lines: string[],
  recall: MemoryTdaiConfig["recall"],
  logger?: Logger,
): string[] {
  const maxCharsPerMemory = normalizeBudgetLimit(recall.maxCharsPerMemory);
  const maxTotalRecallChars = normalizeBudgetLimit(recall.maxTotalRecallChars);

  if (!maxCharsPerMemory && !maxTotalRecallChars) {
    return lines;
  }

  const budgeted: string[] = [];
  let usedChars = 0;
  let truncatedCount = 0;
  let droppedCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const perMemoryBounded = maxCharsPerMemory
      ? truncateRecallLine(line, maxCharsPerMemory)
      : line;
    let wasTruncated = perMemoryBounded !== line;

    if (!maxTotalRecallChars) {
      budgeted.push(perMemoryBounded);
      if (wasTruncated) truncatedCount++;
      continue;
    }

    const separatorChars = budgeted.length > 0 ? RECALL_LINE_SEPARATOR.length : 0;
    const remainingChars = maxTotalRecallChars - usedChars - separatorChars;
    if (remainingChars <= 0) {
      droppedCount += lines.length - i;
      break;
    }

    if (perMemoryBounded.length > remainingChars) {
      const canFit = remainingChars >= MIN_TRUNCATED_RECALL_LINE_CHARS;
      if (canFit) {
        const totalBounded = truncateRecallLine(perMemoryBounded, remainingChars);
        budgeted.push(totalBounded);
        usedChars += separatorChars + totalBounded.length;
        wasTruncated ||= totalBounded !== perMemoryBounded;
        if (wasTruncated) truncatedCount++;
      }
      droppedCount += lines.length - i - (canFit ? 1 : 0);
      break;
    }

    budgeted.push(perMemoryBounded);
    usedChars += separatorChars + perMemoryBounded.length;
    if (wasTruncated) truncatedCount++;
  }

  if (truncatedCount > 0 || droppedCount > 0) {
    logger?.debug?.(
      `${TAG} Recall budget applied: input=${lines.length}, output=${budgeted.length}, ` +
      `truncated=${truncatedCount}, dropped=${droppedCount}, ` +
      `maxCharsPerMemory=${recall.maxCharsPerMemory}, maxTotalRecallChars=${recall.maxTotalRecallChars}`,
    );
  }

  return budgeted;
}

function normalizeBudgetLimit(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.floor(value);
}

function truncateRecallLine(line: string, maxChars: number): string {
  // Count and slice by code point, not UTF-16 code unit, so a cut never lands
  // between the halves of a surrogate pair (which would corrupt a non-BMP
  // character to U+FFFD when the line is UTF-8 encoded for the request).
  const cps = Array.from(line);
  if (cps.length <= maxChars) return line;
  if (maxChars <= RECALL_TRUNCATION_SUFFIX.length) {
    return cps.slice(0, maxChars).join("");
  }
  return `${cps.slice(0, maxChars - RECALL_TRUNCATION_SUFFIX.length).join("").trimEnd()}${RECALL_TRUNCATION_SUFFIX}`;
}

/**
 * Format an ISO 8601 timestamp to a concise, timezone-aware string for display.
 * Uses the configured timezone (via time module).
 * - If the time part is 00:00:00 → show date only (e.g. "2025-03-01")
 * - Otherwise → show full ISO 8601 with offset (e.g. "2025-03-01T14:30:00+08:00")
 * - Returns undefined for empty/invalid inputs.
 */
function formatTimestamp(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  const d = new Date(ts);
  if (isNaN(d.getTime())) return undefined;

  // Check if time part is midnight UTC (date-only semantics)
  const match = ts.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::\d{2})?)?/);
  if (match) {
    const timePart = match[2];
    if (!timePart || timePart === "00:00") {
      return match[1]; // date-only, no timezone conversion needed
    }
  }

  return formatForLLM(ts);
}

/**
 * Build a FormatableMemory from a full MemoryRecord (keyword search path).
 * Handles empty metadata, empty timestamps array gracefully.
 */
function recordToFormatable(record: MemoryRecord): FormatableMemory {
  const meta = record.metadata as { activity_start_time?: string; activity_end_time?: string } | undefined;
  return {
    record_id: record.id,
    type: record.type,
    content: record.content,
    scene_name: record.scene_name || undefined,
    activity_start_time: meta?.activity_start_time || undefined,
    activity_end_time: meta?.activity_end_time || undefined,
    timestamp: (record.timestamps && record.timestamps.length > 0) ? record.timestamps[0] : undefined,
  };
}

/**
 * Build a FormatableMemory from a VectorSearchResult (embedding search path).
 * Handles empty/invalid metadata_json, empty timestamp_str gracefully.
 */
function vectorResultToFormatable(r: L1SearchResult): FormatableMemory {
  let activityStart: string | undefined;
  let activityEnd: string | undefined;
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json;
      activityStart = meta?.activity_start_time || undefined;
      activityEnd = meta?.activity_end_time || undefined;
    } catch { /* ignore parse errors — treat as no metadata */ }
  }
  return {
    record_id: r.record_id,
    type: r.type,
    content: r.content,
    scene_name: r.scene_name || undefined,
    activity_start_time: activityStart,
    activity_end_time: activityEnd,
    timestamp: r.timestamp_str || undefined,
  };
}

/**
 * Build a FormatableMemory from an FtsSearchResult (FTS5 keyword search path).
 * Handles empty/invalid metadata_json, empty timestamp_str gracefully.
 */
function ftsResultToFormatable(r: L1FtsResult): FormatableMemory {
  let activityStart: string | undefined;
  let activityEnd: string | undefined;
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = typeof r.metadata_json === "string" ? JSON.parse(r.metadata_json) : r.metadata_json;
      activityStart = meta?.activity_start_time || undefined;
      activityEnd = meta?.activity_end_time || undefined;
    } catch { /* ignore parse errors — treat as no metadata */ }
  }
  return {
    record_id: r.record_id,
    type: r.type,
    content: r.content,
    scene_name: r.scene_name || undefined,
    activity_start_time: activityStart,
    activity_end_time: activityEnd,
    timestamp: r.timestamp_str || undefined,
  };
}

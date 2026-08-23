/**
 * Pipeline factory: shared infrastructure for creating and wiring
 * MemoryPipelineManager instances with VectorStore, EmbeddingService,
 * L1 runner, L2 runner, and persister.
 *
 * Used by `index.ts` (live plugin runtime).
 *
 * This avoids duplicating VectorStore init, L1/L2 extraction logic,
 * persister wiring, and destroy sequences.
 */

import fs from "node:fs";
import path from "node:path";
import type { MemoryTdaiConfig } from "../config.js";
import { MemoryPipelineManager } from "./pipeline-manager.js";
import type { L2Runner } from "./pipeline-manager.js";
import { SessionFilter } from "./session-filter.js";
import { extractL1Memories } from "../core/record/l1-extractor.js";
import { readConversationMessagesGroupedBySessionId } from "../core/conversation/l0-recorder.js";
import type { ConversationMessage } from "../core/conversation/l0-recorder.js";
import { CheckpointManager } from "./checkpoint.js";
import type { PipelineSessionState } from "./checkpoint.js";
import { createStoreBundle } from "../core/store/factory.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import { readManifest, writeManifest, buildStoreInfo, diffStoreBinding, type Manifest } from "./manifest.js";
import { pullProfilesToLocal, syncLocalProfilesToStore } from "../core/profile/profile-sync.js";
import type { Logger } from "../core/types.js";

const TAG = "[memory-tdai] [pipeline-factory]";

function supportsProfileSyncWrite(store?: IMemoryStore): boolean {
  return !!(store?.syncProfiles || store?.deleteProfiles);
}

// ============================
// Logger interface
// ============================

/** @deprecated Use `Logger` from `../core/types.js` directly. */
export type PipelineLogger = Logger;

// ============================
// Factory options
// ============================

export interface PipelineFactoryOptions {
  /** Plugin data directory (L0, records, scene_blocks, vectors.db, etc.). */
  pluginDataDir: string;
  /** Parsed memory-tdai config. */
  cfg: MemoryTdaiConfig;
  /** OpenClaw config object (needed for LLM calls in L1). */
  openclawConfig: unknown;
  /** Logger instance. */
  logger: PipelineLogger;
  /** Session filter (optional, defaults to empty). */
  sessionFilter?: SessionFilter;
  /** Host-neutral LLM runner for L1 extraction (text-only, enableTools=false). */
  l1LlmRunner?: import("../core/types.js").LLMRunner;
  /** Host-neutral LLM runner for L2 scene extraction (enableTools=true). */
  l2LlmRunner?: import("../core/types.js").LLMRunner;
  /**
   * Getter for the plugin instance ID used for metric reporting.
   * Called at runner execution time (not at creation time) so that the ID is
   * available even when the runner is wired before instanceId is resolved.
   * Metrics are skipped when the getter returns undefined.
   */
  getInstanceId?: () => string | undefined;
}

// ============================
// Factory result
// ============================

export interface PipelineInstance {
  /** The pipeline scheduler. */
  scheduler: MemoryPipelineManager;
  /** VectorStore (undefined if init failed or degraded). */
  vectorStore: IMemoryStore | undefined;
  /** EmbeddingService (undefined if not configured or init failed). */
  embeddingService: EmbeddingService | undefined;
  /**
   * Destroy all resources (scheduler, VectorStore, EmbeddingService).
   * Call this on shutdown / cleanup.
   */
  destroy: () => Promise<void>;
}

// ============================
// Data directory init
// ============================

/**
 * Ensure all required data subdirectories exist under `pluginDataDir`.
 * Safe to call multiple times (mkdirSync with `recursive: true`).
 */
export function initDataDirectories(dataDir: string): void {
  const dirs = ["conversations", "records", "scene_blocks", ".metadata", ".backup"];
  for (const sub of dirs) {
    fs.mkdirSync(path.join(dataDir, sub), { recursive: true });
  }
}

// ============================
// Store init (once-async singleton)
// ============================

export interface StoreInitResult {
  vectorStore: IMemoryStore | undefined;
  embeddingService: EmbeddingService | undefined;
  /** Whether a background re-index is needed (embedding config changed). */
  needsReindex: boolean;
  reindexReason?: string;
}

/**
 * Cached store init promises — keyed by `pluginDataDir` so that different
 * data directories (e.g. live runtime vs. seed output) each get their own
 * store instance, while concurrent callers for the *same* directory share
 * one initialization.
 */
const _storeInitCache = new Map<string, Promise<StoreInitResult>>();

/**
 * Initialize store backend and (optionally) EmbeddingService.
 *
 * **Once-async semantics per dataDir**: the first call for a given
 * `pluginDataDir` creates the store and caches the result; subsequent
 * calls with the same dir return the cached Promise immediately.
 * Call `resetStores()` during shutdown to clear the cache.
 *
 * Supports both SQLite (sync init) and TCVDB (async init) backends.
 */
export function initStores(
  cfg: MemoryTdaiConfig,
  pluginDataDir: string,
  logger: PipelineLogger,
): Promise<StoreInitResult> {
  const key = pluginDataDir;
  if (!_storeInitCache.has(key)) {
    _storeInitCache.set(key, _doInitStores(cfg, pluginDataDir, logger));
  }
  return _storeInitCache.get(key)!;
}

/**
 * Reset the cached store singleton(s).
 *
 * Call this during `gateway_stop` (after closing the actual store/embedding
 * resources) so that a subsequent `register()` on hot-restart can
 * re-initialize fresh instances.
 *
 * @param pluginDataDir  If provided, only clear the cache for that dir.
 *                       If omitted, clear all cached stores.
 */
export function resetStores(pluginDataDir?: string): void {
  if (pluginDataDir) {
    _storeInitCache.delete(pluginDataDir);
  } else {
    _storeInitCache.clear();
  }
}

/**
 * Internal: actual store initialization logic (called once by the cache).
 */
async function _doInitStores(
  cfg: MemoryTdaiConfig,
  pluginDataDir: string,
  logger: PipelineLogger,
): Promise<StoreInitResult> {
  let vectorStore: IMemoryStore | undefined;
  let embeddingService: EmbeddingService | undefined;
  let needsReindex = false;
  let reindexReason: string | undefined;

  try {
    const bundle = createStoreBundle(cfg, {
      dataDir: pluginDataDir,
      logger,
    });
    vectorStore = bundle.store;
    embeddingService = bundle.embedding ?? undefined;

    const providerInfo = embeddingService?.getProviderInfo();
    const initResult = await vectorStore.init(providerInfo);

    if (vectorStore.isDegraded()) {
      logger.warn(`${TAG} Store is in degraded mode, falling back to keyword dedup`);
      vectorStore = undefined;
      embeddingService = undefined;
    } else {
      logger.debug?.(
        `${TAG} Store initialized: backend=sqlite, provider=${cfg.embedding.provider}`,
      );
      needsReindex = initResult.needsReindex;
      reindexReason = initResult.reason;

      // ── Manifest: first-write + config-drift detection ──
      try {
        const currentStoreInfo = buildStoreInfo(bundle.storeSnapshot);
        const existing = readManifest(pluginDataDir);

        if (!existing) {
          // First init — write manifest
          const manifest: Manifest = {
            version: 1,
            createdAt: new Date().toISOString(),
            store: currentStoreInfo,
            seed: null,
          };
          writeManifest(pluginDataDir, manifest);
          logger.debug?.(`${TAG} Manifest created: ${JSON.stringify(currentStoreInfo)}`);
        } else {
          // Compare persisted store binding against current config
          const diffs = diffStoreBinding(existing.store, currentStoreInfo);
          if (diffs.length > 0) {
            logger.debug?.(
              `${TAG} Store config differs from initial binding recorded in manifest ` +
              `(${diffs.join("; ")}). ` +
              `This is expected if the storage backend was switched intentionally.`,
            );
          }
        }
      } catch (err) {
        logger.warn(`${TAG} Failed to read/write manifest (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    logger.warn(
      `${TAG} Store init failed; vector/FTS recall and dedup conflict detection will be unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
    vectorStore = undefined;
    embeddingService = undefined;
  }

  return { vectorStore, embeddingService, needsReindex, reindexReason };
}

// ============================
// L1 Runner factory
// ============================

/**
 * Create the standard L1 runner function.
 *
 * Reads L0 messages (from VectorStore DB or JSONL fallback), groups by sessionId,
 * runs extractL1Memories for each group, and updates the checkpoint cursor.
 */
export function createL1Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore: IMemoryStore | undefined;
  embeddingService: EmbeddingService | undefined;
  logger: PipelineLogger;
  /**
   * Getter for the plugin instance ID used for metric reporting.
   * Called at runner execution time (not at creation time) so that the ID is
   * available even when the runner is wired before instanceId is resolved.
   * Metrics are skipped when the getter returns undefined.
   */
  getInstanceId?: () => string | undefined;
  /** Host-neutral LLM runner for L1 extraction (standalone/gateway mode). */
  llmRunner?: import("../core/types.js").LLMRunner;
}): (params: { sessionKey: string }) => Promise<{ processedCount: number }> {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, embeddingService, logger, getInstanceId, llmRunner } = opts;
  const config = openclawConfig as Record<string, unknown> | undefined;

  return async ({ sessionKey }) => {
    if (!config && !llmRunner) {
      logger.debug?.(`${TAG} [l1] No OpenClaw config and no LLM runner, skipping L1 extraction`);
      return { processedCount: 0 };
    }

    const checkpoint = new CheckpointManager(pluginDataDir, logger);
    const cp = await checkpoint.read();
    const runnerState = checkpoint.getRunnerState(cp, sessionKey);

    logger.info(
      `${TAG} [l1] Session ${sessionKey}: l1_cursor=${runnerState.last_l1_cursor || "(start)"}`,
    );

    try {
      let groups: Array<{ sessionId: string; messages: ConversationMessage[] }>;
      let maxRecordedAtMs = 0;

      if (vectorStore && !vectorStore.isDegraded()) {
        const l1Cursor = runnerState.last_l1_cursor > 0
          ? runnerState.last_l1_cursor
          : undefined;
        const dbGroups = await vectorStore.queryL0GroupedBySessionId(sessionKey, l1Cursor);
        groups = dbGroups.map((g) => ({
          sessionId: g.sessionId,
          messages: g.messages.map((m) => ({
            id: m.id,
            role: m.role as "user" | "assistant",
            content: m.content,
            timestamp: m.timestamp,
          })),
        }));
        // Compute max recordedAtMs across all groups for cursor advancement
        for (const g of dbGroups) {
          for (const m of g.messages) {
            if (m.recordedAtMs > maxRecordedAtMs) maxRecordedAtMs = m.recordedAtMs;
          }
        }
        logger.debug?.(`${TAG} [l1] L0 data source: VectorStore DB`);
      } else {
        logger.debug?.(`${TAG} [l1] L0 data source: JSONL files (VectorStore unavailable)`);
        const jsonlGroups = await readConversationMessagesGroupedBySessionId(
          sessionKey,
          pluginDataDir,
          runnerState.last_l1_cursor || undefined,
          logger,
          50,
        );
        groups = jsonlGroups.map((g) => ({
          sessionId: g.sessionId,
          messages: g.messages,
        }));
        // Compute max recordedAtMs from JSONL groups
        for (const g of jsonlGroups) {
          for (const m of g.messages) {
            if (m.recordedAtMs > maxRecordedAtMs) maxRecordedAtMs = m.recordedAtMs;
          }
        }
      }

      if (groups.length === 0) {
        logger.debug?.(`${TAG} [l1] No new L0 messages for session ${sessionKey}`);
        return { processedCount: 0 };
      }

      const totalMessages = groups.reduce((sum, g) => sum + g.messages.length, 0);
      logger.info(
        `${TAG} [l1] Processing ${totalMessages} L0 messages across ${groups.length} sessionId group(s) for session ${sessionKey}`,
      );

      let totalExtracted = 0;
      let totalStored = 0;
      let lastSceneName: string | undefined;

      for (const group of groups) {
        logger.debug?.(
          `${TAG} [l1] Group sessionId=${group.sessionId || "(empty)"}: ${group.messages.length} messages`,
        );

        const l1Result = await extractL1Memories({
          messages: group.messages,
          sessionKey,
          sessionId: group.sessionId,
          baseDir: pluginDataDir,
          config,
          options: {
            enableDedup: cfg.extraction.enableDedup,
            maxMemoriesPerSession: cfg.extraction.maxMemoriesPerSession,
            model: cfg.extraction.model,
            previousSceneName: lastSceneName ?? (runnerState.last_scene_name || undefined),
            vectorStore,
            embeddingService,
            conflictRecallTopK: cfg.embedding.conflictRecallTopK,
            embeddingTimeoutMs: cfg.embedding.captureTimeoutMs ?? cfg.embedding.timeoutMs,
            llmRunner,
          },
          logger,
          instanceId: getInstanceId?.(),
        });

        totalExtracted += l1Result.extractedCount;
        totalStored += l1Result.storedCount;
        if (l1Result.lastSceneName) {
          lastSceneName = l1Result.lastSceneName;
        }
      }

      // Use maxRecordedAtMs (write time) as cursor — always positive, TCVDB-safe
      await checkpoint.markL1ExtractionComplete(sessionKey, totalStored, maxRecordedAtMs || undefined, lastSceneName);
      logger.info(
        `${TAG} [l1] L1 complete: extracted=${totalExtracted}, stored=${totalStored} (${groups.length} group(s))`,
      );

      return { processedCount: totalMessages };
    } catch (err) {
      logger.error(`${TAG} [l1] L1 failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      throw err;
    }
  };
}

// ============================
// Persister factory
// ============================

/**
 * Create the standard pipeline state persister.
 * Saves pipeline session states to the checkpoint file.
 */
export function createPersister(
  pluginDataDir: string,
  logger: PipelineLogger,
): (states: Record<string, PipelineSessionState>) => Promise<void> {
  return async (states) => {
    const checkpoint = new CheckpointManager(pluginDataDir, logger);
    await checkpoint.mergePipelineStates(states);
  };
}

// ============================
// L2 Runner factory
// ============================

/**
 * Create the standard L2 runner (v2 scene consolidation).
 *
 * Fetches new L1 memory records since the cursor, attaches their stored
 * embedding vectors (falling back to embedBatch when missing), and hands
 * everything to SceneConsolidator — the deterministic router + two LLM
 * touchpoints (promotion title/summary, summary refresh). Returns the
 * latest cursor for pipeline-manager incremental progress.
 */
export function createL2Runner(opts: {
  pluginDataDir: string;
  cfg: MemoryTdaiConfig;
  openclawConfig: unknown;
  vectorStore: IMemoryStore | undefined;
  embeddingService: EmbeddingService | undefined;
  logger: PipelineLogger;
  instanceId?: string;
  /** Host-neutral LLM runner for scene title/summary synthesis (text-only). */
  llmRunner?: import("../core/types.js").LLMRunner;
}): L2Runner {
  const { pluginDataDir, cfg, openclawConfig, vectorStore, embeddingService, logger, llmRunner } = opts;

  return async (sessionKey: string, cursor?: string) => {
    logger.debug?.(
      `${TAG} [L2] session=${sessionKey}, updatedAfter=${cursor ?? "(full)"}`,
    );

    if (!openclawConfig && !llmRunner) {
      logger.warn(`${TAG} [L2] No OpenClaw config and no LLM runner, skipping scene consolidation`);
      return;
    }

    if (vectorStore?.pullProfiles && !vectorStore.isDegraded()) {
      await pullProfilesToLocal(pluginDataDir, vectorStore, logger).catch(() => new Map());
    }

    let records: Array<{ id: string; content: string; scene_name?: string; createdAt: string; updatedAt: string; sessionKey?: string }>;

    if (vectorStore && !vectorStore.isDegraded()) {
      const { queryMemoryRecords } = await import("../core/record/l1-reader.js");
      const memRecords = await queryMemoryRecords(vectorStore, {
        sessionKey,
        updatedAfter: cursor,
      }, logger);

      if (memRecords.length === 0) {
        logger.debug?.(
          `${TAG} [L2] No new L1 records since cursor (session=${sessionKey}), skipping`,
        );
        return { skipped: true, latestCursor: cursor || undefined };
      }
      records = memRecords;
    } else {
      logger.debug?.(`${TAG} [L2] VectorStore unavailable, falling back to JSONL read (session=${sessionKey})`);
      const { readMemoryRecords } = await import("../core/record/l1-reader.js");
      let sessionRecords = await readMemoryRecords(sessionKey, pluginDataDir, logger);
      if (cursor) {
        sessionRecords = sessionRecords.filter((r) => {
          const t = r.updatedAt || r.createdAt || "";
          return t > cursor;
        });
      }
      if (sessionRecords.length === 0) {
        return { latestCursor: cursor || undefined };
      }
      records = sessionRecords;
    }

    // Attach stored embedding vectors for routing; embed missing ones.
    const embeddings = await resolveEmbeddings(records, vectorStore, embeddingService, logger);

    const { SceneConsolidator } = await import("../core/scene/scene-consolidator.js");
    const consolidator = new SceneConsolidator({
      dataDir: pluginDataDir,
      config: openclawConfig,
      model: cfg.persona.model,
      llmRunner,
      embeddingService,
      logger,
      ttlDays: cfg.persona.sceneTtlDays,
      routingThreshold: cfg.persona.sceneRoutingThreshold,
      promoteThresholdMemories: cfg.persona.sceneCreateThresholdMemories,
      promoteThresholdSessions: cfg.persona.sceneCreateThresholdSessions,
      candidateTtlDays: cfg.persona.sceneCandidateTtlDays,
      summaryRefreshDays: cfg.persona.sceneSummaryRefreshDays,
      summaryRefreshNewMemories: cfg.persona.sceneSummaryRefreshNewMemories,
      summaryMaxChars: cfg.persona.sceneSummaryMaxChars,
    });

    await consolidator.consolidate(
      records.map((r) => ({
        id: r.id,
        content: r.content,
        sceneName: r.scene_name,
        createdAt: r.createdAt,
        sessionKey: r.sessionKey,
        embedding: embeddings.get(r.id),
      })),
    );

    if (vectorStore && supportsProfileSyncWrite(vectorStore)) {
      await syncLocalProfilesToStore(pluginDataDir, vectorStore, new Map(), logger).catch((err) => {
        logger.warn?.(`${TAG} [L2] profile sync write-back failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    const latestCursor = records.reduce((latest, r) => {
      return r.updatedAt > latest ? r.updatedAt : latest;
    }, "");
    logger.debug?.(`${TAG} [L2] Consolidation complete: ${records.length} records, latestCursor=${latestCursor}`);
    return { latestCursor: latestCursor || undefined };
  };
}

/**
 * Resolve routing embeddings for a batch of L1 records: prefer vectors
 * already stored in vectors.db; embed the remainder (up to a bound) via
 * the embedding service. Records left without a vector degrade to the
 * router's text-fallback signal.
 */
async function resolveEmbeddings(
  records: Array<{ id: string; content: string }>,
  vectorStore: IMemoryStore | undefined,
  embeddingService: EmbeddingService | undefined,
  logger: PipelineLogger,
): Promise<Map<string, Float32Array | number[]>> {
  const byId = new Map<string, Float32Array | number[]>();

  if (vectorStore?.getL1Embeddings && !vectorStore.isDegraded()) {
    try {
      const rows = await vectorStore.getL1Embeddings(records.map((r) => r.id));
      for (const row of rows) {
        if (row.embedding) byId.set(row.record_id, row.embedding);
      }
    } catch (err) {
      logger.warn?.(`${TAG} [L2] getL1Embeddings failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const missing = records.filter((r) => !byId.has(r.id) && r.content);
  if (missing.length > 0 && embeddingService) {
    try {
      const vectors = await embeddingService.embedBatch(missing.map((r) => r.content));
      for (let i = 0; i < missing.length; i++) {
        if (vectors[i] && vectors[i]!.length > 0) byId.set(missing[i]!.id, vectors[i]!);
      }
    } catch (err) {
      logger.warn?.(
        `${TAG} [L2] embedBatch fallback failed (${missing.length} records degrade to text routing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return byId;
}

// ============================
// Pipeline Manager factory
// ============================

/**
 * Create a MemoryPipelineManager with the standard config mapping.
 */
export function createPipelineManager(
  cfg: MemoryTdaiConfig,
  logger: PipelineLogger,
  sessionFilter?: SessionFilter,
): MemoryPipelineManager {
  return new MemoryPipelineManager(
    {
      everyNConversations: cfg.pipeline.everyNConversations,
      enableWarmup: cfg.pipeline.enableWarmup,
      l1: { idleTimeoutSeconds: cfg.pipeline.l1IdleTimeoutSeconds },
      l2: {
        delayAfterL1Seconds: cfg.pipeline.l2DelayAfterL1Seconds,
        minIntervalSeconds: cfg.pipeline.l2MinIntervalSeconds,
        maxIntervalSeconds: cfg.pipeline.l2MaxIntervalSeconds,
        sessionActiveWindowHours: cfg.pipeline.sessionActiveWindowHours,
      },
    },
    logger,
    sessionFilter ?? new SessionFilter([]),
  );
}

// ============================
// Standalone LLM runner factory
// ============================

function standaloneLlmConfigured(cfg: MemoryTdaiConfig): boolean {
  return cfg.llm.enabled && !!cfg.llm.apiKey;
}

/**
 * Build the L1 standalone LLM runner (text-only) from `cfg.llm`.
 *
 * Parity with the old `TdaiCore.wirePipelineRunners()`: when `llm.enabled` is
 * set (with an API key), L1 extraction bypasses the OpenClaw embedded agent
 * and calls the configured OpenAI-compatible endpoint directly.
 *
 * Returns `undefined` when the standalone override is not configured.
 */
export async function createStandaloneL1RunnerFromConfig(
  cfg: MemoryTdaiConfig,
): Promise<import("../core/types.js").LLMRunner | undefined> {
  if (!standaloneLlmConfigured(cfg)) return undefined;

  const { createOpenAICompatibleRunner } = await import("../core/utils/openai-runner.js");
  return createOpenAICompatibleRunner({
    baseUrl: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey,
    model: cfg.llm.model,
    maxTokens: cfg.llm.maxTokens,
    timeoutMs: cfg.llm.timeoutMs,
    disableThinking: cfg.llm.disableThinking,
  });
}

/**
 * Build the L2 standalone LLM runner (text-only) from `cfg.llm`.
 *
 * v2 L2 touches the LLM only for scene title/summary synthesis — single-turn
 * JSON calls with no file tools — so the plain OpenAI-compatible runner is
 * sufficient. Returns `undefined` when the override is not configured.
 */
export async function createStandaloneL2RunnerFromConfig(
  cfg: MemoryTdaiConfig,
): Promise<import("../core/types.js").LLMRunner | undefined> {
  if (!standaloneLlmConfigured(cfg)) return undefined;

  const { createOpenAICompatibleRunner } = await import("../core/utils/openai-runner.js");
  return createOpenAICompatibleRunner({
    baseUrl: cfg.llm.baseUrl,
    apiKey: cfg.llm.apiKey,
    model: cfg.llm.model,
    maxTokens: cfg.llm.maxTokens,
    timeoutMs: cfg.llm.timeoutMs,
    disableThinking: cfg.llm.disableThinking,
  });
}

// ============================
// Full pipeline factory
// ============================

/**
 * Create a fully wired pipeline instance: VectorStore + EmbeddingService +
 * MemoryPipelineManager with L1 runner, L2 runner, and persister attached.
 *
 * This is the high-level entry point used by `index.ts`.
 * When `cfg.llm.enabled` is set, standalone LLM runners are derived from the
 * config (unless explicitly overridden via `l1LlmRunner`/`l2LlmRunner`).
 */
export async function createPipeline(opts: PipelineFactoryOptions): Promise<PipelineInstance> {
  const { pluginDataDir, cfg, openclawConfig, logger, sessionFilter, getInstanceId } = opts;

  // Ensure data directories exist
  initDataDirectories(pluginDataDir);

  // Initialize stores (once-async: reuses cached result if already initialized)
  const stores = await initStores(cfg, pluginDataDir, logger);
  const { vectorStore, embeddingService } = stores;

  // Standalone LLM override (parity with old TdaiCore.wirePipelineRunners):
  // when cfg.llm is enabled, L1/L2 extraction bypasses the host embedded agent.
  // Explicitly passed runners take precedence over the config-derived ones.
  let l1LlmRunner = opts.l1LlmRunner;
  let l2LlmRunner = opts.l2LlmRunner;
  if (standaloneLlmConfigured(cfg) && (!l1LlmRunner || !l2LlmRunner)) {
    if (!l1LlmRunner) l1LlmRunner = await createStandaloneL1RunnerFromConfig(cfg);
    if (!l2LlmRunner) l2LlmRunner = await createStandaloneL2RunnerFromConfig(cfg);
    logger.info(
      `${TAG} Using standalone LLM override: model=${cfg.llm.model}, baseUrl=${cfg.llm.baseUrl}`,
    );
  }

  // Create pipeline manager
  const scheduler = createPipelineManager(cfg, logger, sessionFilter);

  // Wire L1 runner
  scheduler.setL1Runner(createL1Runner({
    pluginDataDir,
    cfg,
    openclawConfig,
    vectorStore,
    embeddingService,
    logger,
    getInstanceId,
    llmRunner: l1LlmRunner,
  }));

  // Wire persister
  scheduler.setPersister(createPersister(pluginDataDir, logger));

  // Wire L2 runner (v2 scene consolidation). The inner runner is created lazily at
  // execution time so getInstanceId() resolves after async instanceId init.
  scheduler.setL2Runner(async (sessionKey: string, cursor?: string) => {
    const l2Runner = createL2Runner({
      pluginDataDir,
      cfg,
      openclawConfig,
      vectorStore,
      embeddingService,
      logger,
      instanceId: getInstanceId?.(),
      llmRunner: l2LlmRunner,
    });
    return l2Runner(sessionKey, cursor);
  });

  // Destroy function
  const destroy = async () => {
    logger.info(`${TAG} Destroying pipeline...`);
    await scheduler.destroy();
    if (vectorStore) {
      logger.info(`${TAG} Closing VectorStore`);
      vectorStore.close();
    }
    if (embeddingService?.close) {
      try {
        logger.info(`${TAG} Closing EmbeddingService`);
        await embeddingService.close();
      } catch (err) {
        logger.warn(`${TAG} Error closing EmbeddingService: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    resetStores(pluginDataDir);
    logger.info(`${TAG} Pipeline destroyed`);
  };

  return { scheduler, vectorStore, embeddingService, destroy };
}

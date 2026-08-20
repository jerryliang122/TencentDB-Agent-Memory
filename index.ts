/**
 * memory-tencentdb: Four-layer memory system plugin for OpenClaw.
 *
 * Provides:
 * - L0: Automatic conversation recording (SQLite)
 * - L1: Structured memory extraction (LLM + dedup)
 * - L2: Scene block management (LLM scene extraction)
 *
 * All processing is local, zero external API dependencies.
 */

import path from "node:path";
import { createRequire } from "node:module";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { parseConfig } from "./src/config.js";
import type { MemoryTdaiConfig } from "./src/config.js";
import { initTimeModule } from "./src/utils/time.js";
import { registerOffload } from "./src/offload/index.js";
import {
  setPreferredEmbeddedAgentRuntime,
  prewarmEmbeddedAgent,
} from "./src/utils/clean-context-runner.js";
import { SessionFilter } from "./src/utils/session-filter.js";
import { LocalMemoryCleaner } from "./src/utils/memory-cleaner.js";
import { registerMemoryTdaiCli } from "./src/cli/index.js";
import { initDataDirectories, resetStores, createPipeline } from "./src/utils/pipeline-factory.js";
import { getOrCreateInstanceId, initReporter, report, resetReporter } from "./src/core/report/reporter.js";
import { ensureL2L3Local } from "./src/core/profile/profile-sync.js";
import { performAutoRecall } from "./src/core/hooks/auto-recall.js";
import { performAutoCapture } from "./src/core/hooks/auto-capture.js";
import {
  ensurePluginHookPolicy,
  decideHookPolicy,
} from "./src/utils/ensure-hook-policy.js";
import { resolveOpenClawStateDir } from "./src/utils/openclaw-state-dir.js";
import type { IMemoryStore } from "./src/core/store/types.js";
import type { EmbeddingService } from "./src/core/store/embedding.js";
import type { MemoryPipelineManager } from "./src/utils/pipeline-manager.js";
import type { Logger } from "./src/core/types.js";

import { createMemorySearchTool, createMemoryGetTool, createConversationSearchTool } from "./src/tools/index.js";

const TAG = "[memory-tdai]";

let pluginStartTimestamp = 0;

const pendingOriginalPrompts = new Map<string, { text: string; ts: number; messageCount: number }>();
const pendingRecallCache = new Map<string, {
  l1Memories: Array<{ content: string; score: number; type: string }>;
  l3Persona: string | null;
  strategy: string;
  durationMs: number;
  ts: number;
}>();
const pendingRecallEndTimestamps = new Map<string, number>();
const pendingTranscriptInjection = new Map<string, { text: string; ts: number }>();

const PROMPT_CACHE_TTL_MS = 10 * 60 * 1000;
const PROMPT_CACHE_MAX_SIZE = 10_000;

let sharedMemoryCleaner: LocalMemoryCleaner | undefined;

function sweepStaleCaches(): void {
  const now = Date.now();
  for (const [key, entry] of pendingOriginalPrompts) {
    if (now - entry.ts > PROMPT_CACHE_TTL_MS) {
      pendingOriginalPrompts.delete(key);
      pendingRecallEndTimestamps.delete(key);
    }
  }
  for (const [key, entry] of pendingRecallCache) {
    if (now - entry.ts > PROMPT_CACHE_TTL_MS) {
      pendingRecallCache.delete(key);
    }
  }
  for (const [key, entry] of pendingTranscriptInjection) {
    if (now - entry.ts > PROMPT_CACHE_TTL_MS) {
      pendingTranscriptInjection.delete(key);
    }
  }
  if (pendingOriginalPrompts.size > PROMPT_CACHE_MAX_SIZE) {
    const entries = [...pendingOriginalPrompts.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toEvict = entries.slice(0, entries.length - PROMPT_CACHE_MAX_SIZE);
    for (const [key] of toEvict) {
      pendingOriginalPrompts.delete(key);
      pendingRecallEndTimestamps.delete(key);
    }
  }
  if (pendingRecallCache.size > PROMPT_CACHE_MAX_SIZE) {
    const entries = [...pendingRecallCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toEvict = entries.slice(0, entries.length - PROMPT_CACHE_MAX_SIZE);
    for (const [key] of toEvict) {
      pendingRecallCache.delete(key);
    }
  }
  if (pendingTranscriptInjection.size > PROMPT_CACHE_MAX_SIZE) {
    const entries = [...pendingTranscriptInjection.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toEvict = entries.slice(0, entries.length - PROMPT_CACHE_MAX_SIZE);
    for (const [key] of toEvict) {
      pendingTranscriptInjection.delete(key);
    }
  }
}

export default function register(api: OpenClawPluginApi) {
  if (api.registrationMode === "cli-metadata") {
    api.registerCli(
      ({ program, config, logger: cliLogger }) => {
        const memoryTdai = program
          .command("memory-tdai")
          .description("memory-tdai plugin commands (seed, query, stats)");
        registerMemoryTdaiCli(memoryTdai, {
          config,
          pluginConfig: api.pluginConfig,
          stateDir: resolveOpenClawStateDir((api.runtime as any)?.state),
          logger: cliLogger,
        });
      },
      { commands: ["memory-tdai"] },
    );
    return;
  }

  pluginStartTimestamp = Date.now();
  setPreferredEmbeddedAgentRuntime(api.runtime.agent);
  resetReporter();
  const _require = createRequire(import.meta.url);
  const pluginVersion = (() => { try { return (_require("./package.json") as { version?: string }).version ?? "unknown"; } catch { return "unknown"; } })();

  let cfg: MemoryTdaiConfig;
  try {
    const rawPluginConfig = api.pluginConfig as Record<string, unknown> | undefined;
    cfg = parseConfig(rawPluginConfig);
  } catch (err) {
    api.logger.error(`${TAG} Config parsing failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  initTimeModule({ timezone: cfg.timezone }, api.logger);

  {
    const rawVersion = (api.runtime as any)?.version;
    const decision = decideHookPolicy(rawVersion);
    if (decision.apply) {
      try {
        ensurePluginHookPolicy({
          rootConfig: api.config,
          runtimeConfig: api.runtime?.config,
          logger: api.logger,
        });
      } catch (err) {
        api.logger.warn(`${TAG} Hook policy check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (cfg.embedding.configError) {
    api.logger.error(`${TAG} [EMBEDDING CONFIG ERROR] ${cfg.embedding.configError}`);
  }

  const openclawStateDir = resolveOpenClawStateDir((api.runtime as any)?.state);
  const pluginDataDir = path.join(openclawStateDir, "memory-tdai");
  initDataDirectories(pluginDataDir);

  const sessionFilter = new SessionFilter(cfg.capture.excludeAgents);

  let vectorStore: IMemoryStore | undefined;
  let embeddingService: EmbeddingService | undefined;
  let scheduler: MemoryPipelineManager | undefined;
  let pipelineDestroy: (() => Promise<void>) | undefined;
  const bgTasks = new Set<Promise<void>>();

  const coreReady = createPipeline({
    pluginDataDir,
    cfg,
    openclawConfig: api.config,
    logger: api.logger,
    sessionFilter,
  }).then((pipeline) => {
    vectorStore = pipeline.vectorStore;
    embeddingService = pipeline.embeddingService;
    scheduler = pipeline.scheduler;
    pipelineDestroy = pipeline.destroy;

    if (vectorStore) {
      memoryCleaner?.setVectorStore(vectorStore);
      if (vectorStore.pullProfiles) {
        ensureL2L3Local(pluginDataDir, vectorStore, api.logger).catch((err) => {
          api.logger.warn(`${TAG} Startup L2/L3 pull failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }
  }).catch((err) => {
    api.logger.error(`${TAG} Pipeline init failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  let instanceId: string | undefined;
  getOrCreateInstanceId(pluginDataDir).then((id) => {
    instanceId = id;
    initReporter({ enabled: cfg.report.enabled, type: cfg.report.type, logger: api.logger, instanceId: id, pluginVersion });
  }).catch((err) => {
    api.logger.warn(`${TAG} Failed to initialize instanceId for metrics: ${err instanceof Error ? err.message : String(err)}`);
  });

  let memoryCleaner: LocalMemoryCleaner | undefined;
  if (cfg.memoryCleanup.enabled && cfg.memoryCleanup.retentionDays != null) {
    if (!sharedMemoryCleaner) {
      sharedMemoryCleaner = new LocalMemoryCleaner({
        baseDir: pluginDataDir,
        retentionDays: cfg.memoryCleanup.retentionDays,
        cleanTime: cfg.memoryCleanup.cleanTime,
        logger: api.logger,
        sceneTtlDays: cfg.persona.sceneTtlDays,
        sceneCandidateTtlDays: cfg.persona.sceneCandidateTtlDays,
      });
      sharedMemoryCleaner.start();
    }
    memoryCleaner = sharedMemoryCleaner;
  }

  const resolveSessionKey = (sessionKey?: string): string | undefined => {
    if (sessionKey) return sessionKey;
    api.logger.warn(`${TAG} sessionKey is empty, skipping capture/recall to avoid unstable fallback key`);
    return undefined;
  };

  let embeddingWarmupTriggered = false;
  const ensureEmbeddingWarmup = (): void => {
    if (!embeddingService) return;
    if (!embeddingWarmupTriggered) {
      embeddingWarmupTriggered = true;
      embeddingService.startWarmup();
      return;
    }
    if (!embeddingService.isReady()) {
      embeddingService.startWarmup();
    }
  };

  // ============================
  // Tool registration
  // ============================
  if (cfg.recall.enabled || cfg.capture.enabled) {
    const toolOptions = {
      get vectorStore() { return vectorStore; },
      get embeddingService() { return embeddingService; },
      logger: api.logger,
    };

    api.registerTool(() => createMemorySearchTool(toolOptions), { names: ["tdai_memory_search"] });
    api.registerTool(() => createMemoryGetTool(toolOptions), { names: ["tdai_memory_get"] });
    api.registerTool(() => createConversationSearchTool(toolOptions), { names: ["tdai_conversation_search"] });
  }

  // ============================
  // Hooks
  // ============================
  if (cfg.recall.enabled) {
    api.on("before_prompt_build", async (event, ctx) => {
      const startMs = Date.now();
      const sessionKey = ctx.sessionKey;

      if (sessionFilter.shouldSkipCtx(ctx)) return;

      ensureEmbeddingWarmup();

      const rawPrompt = event.prompt;
      const messages = Array.isArray(event.messages) ? event.messages : undefined;
      if (sessionKey && rawPrompt) {
        const messageCount = messages?.length ?? 0;
        pendingOriginalPrompts.set(sessionKey, { text: rawPrompt, ts: Date.now(), messageCount });
      }
      sweepStaleCaches();

      const userText = rawPrompt;
      if (!userText) return;

      const resolvedSessionKey = resolveSessionKey(sessionKey);
      if (!resolvedSessionKey) return;

      try {
        await coreReady;
        const recallStartMs = Date.now();
        const result = await performAutoRecall({
          userText,
          actorId: ctx.agentId ?? "",
          sessionKey: resolvedSessionKey,
          cfg,
          pluginDataDir,
          logger: api.logger,
          vectorStore,
          embeddingService,
        });
        const elapsedMs = Date.now() - startMs;
        const recallDurationMs = Date.now() - recallStartMs;

        if (sessionKey && result) {
          pendingRecallCache.set(sessionKey, {
            l1Memories: result.recalledL1Memories ?? [],
            l3Persona: result.recalledL3Persona ?? null,
            strategy: result.recallStrategy ?? "unknown",
            durationMs: recallDurationMs,
            ts: Date.now(),
          });
        }

        if (resolvedSessionKey) {
          pendingRecallEndTimestamps.set(resolvedSessionKey, Date.now());
        }

        if (result?.appendSystemContext || result?.prependContext) {
          api.logger.info(`${TAG} [before_prompt_build] Recall complete (${elapsedMs}ms)`);
        }

        if (cfg.recall.persistToTranscript && sessionKey && result?.prependContext) {
          pendingTranscriptInjection.set(sessionKey, { text: result.prependContext, ts: Date.now() });
          return { ...result, prependContext: undefined };
        }

        return result;
      } catch (err) {
        api.logger.error(`${TAG} [before_prompt_build] Auto-recall failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  api.on("before_message_write", (event, ctx) => {
    const msg = event.message as { role?: string; content?: unknown };
    if (msg.role !== "user") return;

    const sessionKey = ctx?.sessionKey;

    if (cfg.recall.persistToTranscript) {
      if (!sessionKey) return;
      const pending = pendingTranscriptInjection.get(sessionKey);
      if (!pending) return;
      pendingTranscriptInjection.delete(sessionKey);

      const prependText = pending.text;
      if (typeof msg.content === "string") {
        if (msg.content.includes("<relevant-memories>")) return;
        return { message: { ...event.message, content: `${prependText}\n\n${msg.content}` } as typeof event.message };
      }

      if (Array.isArray(msg.content)) {
        let injected = false;
        const newParts = (msg.content as Array<Record<string, unknown>>).map((part) => {
          if (injected) return part;
          if (part.type !== "text" || typeof part.text !== "string") return part;
          if ((part.text as string).includes("<relevant-memories>")) return part;
          injected = true;
          return { ...part, text: `${prependText}\n\n${part.text}` };
        });
        if (!injected) return;
        return { message: { ...event.message, content: newParts } as unknown as typeof event.message };
      }
      return;
    }

    const STRIP_RE = /<relevant-memories>[\s\S]*?<\/relevant-memories>\s*/g;

    if (typeof msg.content === "string") {
      if (!msg.content.includes("<relevant-memories>")) return;
      const cleaned = msg.content.replace(STRIP_RE, "").trim();
      if (cleaned === msg.content) return;
      return { message: { ...event.message, content: cleaned } as typeof event.message };
    }

    if (Array.isArray(msg.content)) {
      let totalStripped = 0;
      const cleanedParts = (msg.content as Array<Record<string, unknown>>).map((part) => {
        if (part.type !== "text" || typeof part.text !== "string") return part;
        if (!(part.text as string).includes("<relevant-memories>")) return part;
        const cleaned = (part.text as string).replace(STRIP_RE, "").trim();
        totalStripped += (part.text as string).length - cleaned.length;
        return { ...part, text: cleaned };
      });
      if (totalStripped === 0) return;
      return { message: { ...event.message, content: cleanedParts } as unknown as typeof event.message };
    }
  });

  if (cfg.capture.enabled) {
    api.on("agent_end", async (event, ctx) => {
      const startMs = Date.now();
      const e = event as Record<string, unknown>;
      if (!e.success) return;

      const sessionKey = ctx.sessionKey;
      const sessionId = ctx.sessionId;

      if (sessionFilter.shouldSkipCtx(ctx)) return;

      const messages = (e.messages as unknown[]) ?? [];
      const resolvedSessionKey = resolveSessionKey(sessionKey);
      if (!resolvedSessionKey) return;

      const recallEndTs = pendingRecallEndTimestamps.get(resolvedSessionKey);
      if (recallEndTs) {
        pendingRecallEndTimestamps.delete(resolvedSessionKey);
      }

      const cachedPrompt = sessionKey ? pendingOriginalPrompts.get(sessionKey) : undefined;
      const originalUserText = cachedPrompt?.text;

      try {
        await coreReady;

        if (scheduler && !scheduler.isDestroyed) {
          prewarmEmbeddedAgent(api.logger, api.runtime.agent);
        }

        const captureResult = await performAutoCapture({
          messages,
          sessionKey: resolvedSessionKey,
          sessionId: sessionId || undefined,
          cfg,
          pluginDataDir,
          logger: api.logger,
          scheduler,
          originalUserText,
          originalUserMessageCount: cachedPrompt?.messageCount,
          pluginStartTimestamp,
          vectorStore,
          embeddingService,
          bgTaskRegistry: bgTasks,
        });
        const captureMs = Date.now() - startMs;
        api.logger.info(`${TAG} [agent_end] Auto-capture complete (${captureMs}ms)`);

        const cachedRecall = sessionKey ? pendingRecallCache.get(sessionKey) : undefined;
        if (sessionKey) pendingRecallCache.delete(sessionKey);

        if (instanceId) {
          report("agent_turn", {
            sessionKey: resolvedSessionKey,
            userPrompt: originalUserText ?? null,
            recalledL1Memories: cachedRecall?.l1Memories ?? [],
            recalledL1Count: cachedRecall?.l1Memories?.length ?? 0,
            recalledL3Persona: cachedRecall?.l3Persona ?? null,
            recallStrategy: cachedRecall?.strategy ?? null,
            recallDurationMs: cachedRecall?.durationMs ?? 0,
            l0CapturedMessages: captureResult.filteredMessages.map((m) => ({
              role: m.role,
              content: m.content,
              ts: m.timestamp,
            })),
            l0CapturedCount: captureResult.l0RecordedCount,
            l0VectorsWritten: captureResult.l0VectorsWritten,
            captureDurationMs: captureMs,
            totalDurationMs: Date.now() - startMs,
          });
        }
      } catch (err) {
        api.logger.error(`${TAG} [agent_end] Auto-capture failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    api.on("gateway_stop", async () => {
      const GATEWAY_STOP_TIMEOUT_MS = 3_000;
      const hookStartMs = Date.now();

      await coreReady.catch(() => {});

      const doCleanup = async (): Promise<void> => {
        if (memoryCleaner) {
          try {
            memoryCleaner.destroy();
            if (sharedMemoryCleaner === memoryCleaner) {
              sharedMemoryCleaner = undefined;
            }
          } catch (error) {
            api.logger.error(`${TAG} [gateway_stop] memoryCleaner error: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        if (pipelineDestroy) {
          await pipelineDestroy();
        }
      };

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          doCleanup(),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error("timeout")), GATEWAY_STOP_TIMEOUT_MS);
          }),
        ]);
      } catch (err) {
        api.logger.warn(`${TAG} [gateway_stop] Aborted: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }

      resetStores();
      api.logger.info(`${TAG} [gateway_stop] Cleanup finished (${Date.now() - hookStartMs}ms)`);
    });
  }

  if (memoryCleaner && !cfg.extraction.enabled) {
    api.on("gateway_stop", async () => {
      try {
        memoryCleaner?.destroy();
        if (sharedMemoryCleaner === memoryCleaner) {
          sharedMemoryCleaner = undefined;
        }
      } catch (error) {
        api.logger.error(`${TAG} [gateway_stop] Memory cleaner destruction error: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  if (cfg.offload.enabled) {
    try {
      registerOffload(api, cfg.offload);
    } catch (err) {
      api.logger.error(`${TAG} Offload module registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  api.registerCli(
    ({ program, config, logger: cliLogger }) => {
      const memoryTdai = program
        .command("memory-tdai")
        .description("memory-tdai plugin commands (seed, query, stats)");
      registerMemoryTdaiCli(memoryTdai, {
        config,
        pluginConfig: api.pluginConfig,
        stateDir: openclawStateDir,
        logger: cliLogger,
      });
    },
    { commands: ["memory-tdai"] },
  );
}

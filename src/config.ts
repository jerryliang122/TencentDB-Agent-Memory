/**
 * Plugin configuration types and parser (v3).
 *
 * Config is organized into flat functional groups:
 *   capture, extraction, persona, pipeline, recall, embedding
 *
 * Minimal config (zero config): {} — all fields have sensible defaults.
 */

import type { DisableThinkingStrategy } from "./utils/no-think-fetch.js";
import { normalizeDisableThinking } from "./utils/no-think-fetch.js";

// ============================
// Type definitions
// ============================

/** Capture settings — controls L0 conversation recording. */
export interface CaptureConfig {
  /** Enable auto-capture (default: true) */
  enabled: boolean;
  /** Glob patterns to exclude agents (e.g. "bench-judge-*"); matched agents are fully ignored */
  excludeAgents: string[];
  /**
   * L0/L1 local file retention days used as TTL switch.
   * 0 means cleanup disabled.(default: 0)
   */
  l0l1RetentionDays: number;

  /**
   * Allow dangerous low retention (1 or 2 days).
   * Default false: when disabled, non-zero retention must be >= 3.
   */
  allowAggressiveCleanup: boolean;
}

/** Extraction settings (L1) — controls memory extraction from conversations. */
export interface ExtractionConfig {
  /** Enable background extraction (default: true) */
  enabled: boolean;
  /** Enable L1 smart dedup (default: true) */
  enableDedup: boolean;
  /** Max memories per session (default: 20) */
  maxMemoriesPerSession: number;
  /** LLM model for extraction, format: "provider/model" (falls back to OpenClaw default model when omitted) */
  model?: string;
}

/** Persona (L2) settings — controls scene extraction and active-scene injection. */
export interface PersonaConfig {
  /** @deprecated L3 persona generation disabled in redesign. Field kept for backward compat. */
  triggerEveryN: number;
  /** Max scene blocks (default: 15) — used as warning threshold only */
  maxScenes: number;
  /** @deprecated Persona backup count (persona generation disabled). */
  backupCount: number;
  /** Scene blocks backup count (default: 10) */
  sceneBackupCount: number;
  /** LLM model for scene extraction (L2), format: "provider/model" (falls back to OpenClaw default model when omitted). */
  model?: string;

  /** Max characters per scene file. Engineering-enforced (default: 2000). */
  sceneMaxChars: number;
  /** Single-UPDATE length growth ratio limit (default: 1.5). */
  sceneGrowthLimit: number;
  /** Full rewrite interval in hours. UPDATEs beyond this must use write, not edit (default: 24). */
  sceneFullRewriteIntervalHours: number;
  /** Scene TTL in days. Scenes whose last activity is older are archived away and stop being injected (default: 30, 0=disabled). */
  sceneTtlDays: number;
  /** Candidate pool: memory count threshold for promotion (default: 5). */
  sceneCreateThresholdMemories: number;
  /** Candidate pool: distinct session count threshold for promotion (default: 3). */
  sceneCreateThresholdSessions: number;
  /** Candidate pool TTL in days (default: 30). */
  sceneCandidateTtlDays: number;
  /** @deprecated v2 L2 injects every TTL-active scene; top-K cap no longer applied. Field kept for backward compat. */
  sceneInjectTopK: number;
  /** @deprecated v2 L2 caps summaries at sceneSummaryMaxChars instead. Field kept for backward compat. */
  sceneInjectSummaryChars: number;
  /** Routing: cosine threshold for assigning a memory to a scene anchor (default: 0.55, empirically calibrated on BGE-M3 production vectors — same-topic nearest neighbors score P50≈0.73 while unrelated pairs P50≈0.48; unmatched memories safely flow to the candidate pool). */
  sceneRoutingThreshold: number;
  /** Hard cap for the one-line scene summary, engineering-enforced (default: 80). */
  sceneSummaryMaxChars: number;
  /** Summary refresh: max days before a scene with new memories gets its summary regenerated (default: 7). */
  sceneSummaryRefreshDays: number;
  /** Summary refresh: new-memory count that triggers regeneration regardless of age (default: 5). */
  sceneSummaryRefreshNewMemories: number;
}

/** Pipeline trigger settings (L1→L2 scheduling). */
export interface PipelineTriggerConfig {
  /** Trigger L1 after every N conversation rounds (default: 5) */
  everyNConversations: number;
  /** Enable warm-up: start threshold at 1, double after each L1 (1→2→4→...→everyN) (default: true) */
  enableWarmup: boolean;
  /** L1 idle timeout: trigger L1 after this many seconds of inactivity (default: 600) */
  l1IdleTimeoutSeconds: number;
  /** L2 delay after L1: wait this many seconds after L1 completes before triggering L2 (default: 10) */
  l2DelayAfterL1Seconds: number;
  /** L2 min interval: minimum seconds between L2 runs per session (default: 900 = 15 min) */
  l2MinIntervalSeconds: number;
  /** L2 max interval: even without new conversations, trigger L2 at most this often per session (default: 3600 = 60 min) */
  l2MaxIntervalSeconds: number;
  /** Sessions inactive longer than this (hours) stop L2 polling (default: 24) */
  sessionActiveWindowHours: number;
}

/** Recall settings — controls memory retrieval for context injection. */
export interface RecallConfig {
  /** Enable auto-recall (default: true) */
  enabled: boolean;
  /** Max results to return (default: 5) */
  maxResults: number;
  /** Max characters injected for a single recalled L1 memory. 0 disables the per-memory limit. */
  maxCharsPerMemory: number;
  /** Max total characters injected for all recalled L1 memories. 0 disables the total limit. */
  maxTotalRecallChars: number;
  /**
   * Cosine-similarity threshold for the vector recall path (default: 0.55).
   *
   * Applies to embedding scores only. vectors.db uses sqlite-vec
   * `distance_metric=cosine` (score = 1 - distance), so this is a true
   * cosine similarity in [0, 1]. Empirically calibrated on the production
   * corpus (BGE-M3 @cf/baai/bge-m3, single-user Chinese work logs, ~1000 L1
   * memories): unrelated memory pairs score P50≈0.48 / P90≈0.58 (dense
   * single-domain corpus — much higher than the generic BGE-M3 guidance),
   * while real query→memory top-1 hits score P50≈0.65. 0.55 sits in the
   * gap: keeps ~96% of queries recalling (90% cross-session) while cutting
   * the random-pair pass rate to ~18%. Generic band reference:
   *   0.4–0.5 wide / 0.5–0.6 balanced / 0.6–0.7 precise.
   */
  scoreThreshold: number;
  /**
   * Score threshold for the FTS (BM25) recall path (default: 0.35).
   *
   * NOT on the cosine scale: FTS scores come from `bm25RankToScore`
   * (`relevance / (1 + relevance)` over the raw BM25 score), whose
   * distribution differs from cosine — applying the cosine-calibrated
   * scoreThreshold here would over-filter keyword hits. 0.35 ≈ raw BM25 0.54
   * (wide recall): FTS is exact-term matching, so noise risk is low and the
   * RRF merge in hybrid mode prunes further.
   */
  ftsScoreThreshold: number;
  /**
   * Minimum sanitized user-text length (in Unicode code points) required to
   * trigger L1 memory search (default: 6).
   *
   * Short messages (acknowledgments like "好的", "嗯", "ok", "对") carry no
   * semantic intent and produce noisy recall results. When the sanitized
   * user text is shorter than this threshold, L1 memory search is skipped
   * entirely (active scenes are still injected - they are stable, cacheable
   * context independent of the user message).
   *
   * - `0` disables the gate (restores pre-gate behavior; not recommended).
   * - `2` matches the historical hard floor (only filters empty/whitespace).
   * - `6` (default) filters common Chinese/English acknowledgments.
   *
   * Counted on the sanitized text (after `sanitizeText` strips injected
   * tags, metadata blocks, media markers, etc.), so framework-injected
   * prefixes don't inflate the length.
   */
  minQueryChars: number;
  /** Search strategy (default: "hybrid") */
  strategy: "embedding" | "keyword" | "hybrid";
  /** Overall recall timeout in milliseconds (default: 5000). When exceeded, recall is skipped with a warning. */
  timeoutMs: number;
  /**
   * Inject only memory subject (scene_name) + content hint + record_id into
   * the prompt, instead of full content (default: true).
   *
   * When `true`, each recalled memory is rendered as a compact single line:
   *   `- [type|scene] <content首N字 + "…"> (活动时间: ...) [id=m_xxx]`
   * The main agent then fetches full content on demand via the
   * `tdai_memory_get(record_id)` tool when it decides the line is relevant.
   *
   * When `false`, falls back to legacy behavior: full content injection
   * with `maxCharsPerMemory` truncation (no `[id=...]` suffix).
   */
  subjectOnly: boolean;
  /**
   * Number of leading content characters (counted by Unicode code point)
   * to include as a "hint" when `subjectOnly=true`.
   *
   * - `0` = pure subject-only mode (no content fragment at all — the LLM
   *   must rely solely on scene_name + type + time to decide whether to
   *   fetch the full content via `tdai_memory_get`).
   * - `>0` = subject + first N chars + `…` (single-char ellipsis).
   *
   * Default: 60. Clamped to `[0, 500]` by `parseConfig`. Only effective
   * when `subjectOnly=true`.
   */
  subjectHintChars: number;
  /**
   * Persist recalled L1 memories into the user-message transcript via
   * `before_message_write` instead of OpenClaw's non-persistent
   * `prependContext` (default: true).
   *
   * - `true` (default, cache-friendly): `<relevant-memories>` is written
   *   into the JSONL user message so the model-facing prefix is identical
   *   on the next turn, allowing the provider's prompt cache to hit the
   *   full historical prefix. This is the recommended mode for long
   *   multi-turn sessions.
   * - `false` (legacy): memories are injected via `before_prompt_build`'s
   *   `prependContext`, which OpenClaw applies only to the current turn
   *   and does NOT persist. Every turn the previous user message reverts
   *   to its bare form, busting the prompt cache from the first user
   *   message onward. Use only if a downstream consumer cannot tolerate
   *   `<relevant-memories>` tags in the transcript.
   */
  persistToTranscript: boolean;
}

/** Embedding service configuration for vector search. */
export interface EmbeddingConfig {
  /** User-facing default is true in schema, but provider="none" still disables embedding effectively. */
  enabled: boolean;
  /** Embedding provider: default "none" disables vector search; other values (e.g. "openai", "deepseek") are treated as OpenAI-compatible remote providers. */
  provider: string;
  /** API Base URL (required for remote provider). */
  baseUrl: string;
  /** API Key (required for remote provider). */
  apiKey: string;
  /** Model name (required for remote provider). */
  model: string;
  /** Vector dimensions (required for remote provider, must match model). */
  dimensions: number;
  /**
   * Whether to send the `dimensions` field in the embeddings request body.
   * Default true (compatible with OpenAI text-embedding-3-* Matryoshka models).
   * Set to false for self-hosted / OSS models that reject unknown `dimensions`
   * (e.g. BGE-M3, which returns HTTP 400 "does not support matryoshka representation").
   */
  sendDimensions: boolean;
  /** Top-K candidates to recall during conflict detection (default: 5) */
  conflictRecallTopK: number;
  /** Proxy URL for qclaw provider — when provider="qclaw", requests are forwarded through this local proxy */
  proxyUrl?: string;
  /** Max input text length in characters before truncation (default: 5000). Texts exceeding this limit are truncated with a warning. */
  maxInputChars: number;
  /** Timeout per embedding API call in milliseconds (default: 10000). */
  timeoutMs: number;
  /** Override timeoutMs for recall-path embedding calls (user-facing, should be shorter). Falls back to timeoutMs. */
  recallTimeoutMs?: number;
  /** Override timeoutMs for capture-path embedding calls (background L1 dedup, can be longer). Falls back to timeoutMs. */
  captureTimeoutMs?: number;
  /** Internal-only local model cache directory, not exposed in plugin schema. */
  modelCacheDir?: string;
  /** If set, contains an error message about invalid remote config (embedding is disabled) */
  configError?: string;
}

/** Daily cleaner settings for local JSONL data (L0/L1). */
export interface MemoryCleanupConfig {
  /** TTL switch from capture.l0l1RetentionDays. Undefined means disabled. */
  retentionDays?: number;

  /** Whether cleanup is enabled. True only when retentionDays is a valid positive number. */
  enabled: boolean;
  /** Daily execution time in HH:mm format (default: 03:00). */
  cleanTime: string;
}

/** BM25 sparse vector encoding configuration (local @tencentdb-agent-memory/tcvdb-text). */
export interface BM25Config {
  /** Whether BM25 sparse encoding is enabled (default: true) */
  enabled: boolean;
  /** Language for BM25 pre-trained params: "zh" or "en" (default: "zh") */
  language: "zh" | "en";
}

/** Report settings — controls metric/event reporting. */
export interface ReportConfig {
  /** Enable reporting (default: false) */
  enabled: boolean;
  /** Reporter type: "local" logs structured JSON via logger (default: "local") */
  type: string;
}

/**
 * Standalone LLM configuration — when set, TDAI uses direct API calls
 * instead of the host's built-in LLM runner (e.g. OpenClaw's runEmbeddedPiAgent).
 *
 * This allows using a different (often cheaper/faster) model for memory
 * extraction while the main agent uses a premium model.
 *
 * Leave undefined (default) to use the host's native LLM mechanism.
 */
export interface StandaloneLLMOverrideConfig {
  /** Enable standalone LLM mode (default: false). When false, uses host LLM. */
  enabled: boolean;
  /** OpenAI-compatible API base URL (e.g. "https://api.openai.com/v1"). */
  baseUrl: string;
  /** API key for authentication. */
  apiKey: string;
  /** Model name (e.g. "gpt-4o", "deepseek-v3", "claude-sonnet-4-6"). */
  model: string;
  /** Max output tokens (default: 4096). */
  maxTokens: number;
  /** Request timeout in milliseconds (default: 120000). */
  timeoutMs: number;
  /**
   * Controls how thinking/reasoning is disabled for the LLM endpoint (default: false).
   * - `false`: no thinking-disabling wrapper (default)
   * - `"vllm"`: vLLM/SGLang — `chat_template_kwargs: { enable_thinking: false }`
   * - `"deepseek"`: DeepSeek official API — top-level `enable_thinking: false`
   * - `"dashscope"`: Alibaba DashScope (Qwen) — top-level `enable_thinking: false`
   * - `"openai"`: OpenAI o-series — `reasoning_effort: "low"` (cannot fully disable)
   * - `"anthropic"` / `"kimi"`: Anthropic Claude / Kimi (Moonshot) — `thinking: { type: "disabled" }`
   * - `"gemini"`: Google Gemini — `thinking_config: { thinking_budget: 0 }`
   */
  disableThinking: DisableThinkingStrategy;
}

/** Context Offload settings — controls multi-layer context compression. */
export interface OffloadConfig {
  /** Enable context offload (default: false) */
  enabled: boolean;
  /**
   * LLM execution mode for L1/L1.5/L2 tasks.
   * - "local": call LLM directly via AI SDK (uses offload.model or main agent model)
   * - "backend": route through remote backend service (requires backendUrl)
   * - "collect": data collection only — runs L1/L1.5/L2 asynchronously but disables
   *   L3 compression and does NOT occupy the contextEngine slot (uses legacy compaction)
   * Default: "local" (auto-detects based on backendUrl presence for backward compat)
   */
  mode: "local" | "backend" | "collect";
  /** LLM model for offload tasks, format: "provider/model-id". Falls back to agents.defaults.model when omitted. */
  model?: string;
  /** LLM temperature (default: 0.2) */
  temperature: number;
  /**
   * Controls how thinking/reasoning is disabled for the offload local-mode LLM (default: false).
   * See `StandaloneLLMOverrideConfig.disableThinking` for the full list of strategies.
   * Applies only to `mode: "local"`.
   */
  disableThinking: DisableThinkingStrategy;
  /** Force-trigger L1 when pending tool pairs >= this threshold (default: 4) */
  forceTriggerThreshold: number;
  /** Custom data directory (absolute path). Default: ~/.openclaw/context-offload */
  dataDir?: string;
  /** Default context window size (default: 200000) */
  defaultContextWindow: number;
  /** Max tool pairs per L1 batch (default: 20) */
  maxPairsPerBatch: number;
  /** Trigger L2 when node_id=null entries >= this count (default: 4) */
  l2NullThreshold: number;
  /** Trigger L2 if hasn't run for this many seconds (default: 300) */
  l2TimeoutSeconds: number;
  /** Mild compression ratio threshold (default: 0.5) */
  mildOffloadRatio: number;
  /** Aggressive compression ratio threshold (default: 0.85) */
  aggressiveCompressRatio: number;
  /** MMD injection token budget ratio (default: 0.2) */
  mmdMaxTokenRatio: number;
  /** Backend service URL. When set, L1/L1.5/L2/L4 LLM calls go through the backend. */
  backendUrl?: string;
  /** Backend API authentication token */
  backendApiKey?: string;
  /** Backend call timeout in milliseconds (default: 10000) */
  backendTimeoutMs: number;
  /**
   * Offload data retention days. Sessions/refs/mmds older than this are cleaned up.
   * 0 = disabled (default). Values in (0, 3) are treated as invalid and forced to 0.
   * Minimum effective value: 3.
   */
  offloadRetentionDays: number;
  /**
   * Max total size in MB for offload debug log files (*.log in dataRoot).
   * When exceeded, the largest logs are truncated to zero.
   * 0 = disabled. Default: 50.
   */
  logMaxSizeMb: number;
  /**
   * User identifier sent as `X-User-Id` on backend requests. This is the
   * primary key used by the backend `/offload/v1/store` endpoint to upsert
   * per-user state. When omitted the plugin falls back to the machine's
   * primary non-loopback IPv4 address.
   */
  userId?: string;
}

/** Fully resolved plugin configuration (v3). */
export interface MemoryTdaiConfig {
  /**
   * Timezone for user/LLM-facing timestamps and local-day boundaries.
   * - "system" (default): follow process system timezone
   * - IANA name: "Asia/Shanghai", "Europe/Berlin", "UTC"
   * - UTC offset string: "+08:00", "-05:30" (ECMA-402 2024)
   *
   * Storage instants (SQLite/TCVDB) are always UTC regardless of this setting.
   */
  timezone: string;
  capture: CaptureConfig;
  extraction: ExtractionConfig;
  persona: PersonaConfig;
  pipeline: PipelineTriggerConfig;
  recall: RecallConfig;
  embedding: EmbeddingConfig;
  /** BM25 sparse vector encoding (local @tencentdb-agent-memory/tcvdb-text) */
  bm25: BM25Config;
  /** Local JSONL cleanup settings */
  memoryCleanup: MemoryCleanupConfig;
  report: ReportConfig;
  /**
   * Standalone LLM override — when enabled, TDAI bypasses the host's LLM
   * (e.g. OpenClaw's runEmbeddedPiAgent) and uses direct OpenAI-compatible
   * API calls for L1/L2 extraction.
   *
   * Default: disabled (uses host LLM).
   */
  llm: StandaloneLLMOverrideConfig;
  offload: OffloadConfig;
}

// ============================
// Parser
// ============================

/**
 * Parse plugin config from raw user input.
 * All fields have sensible defaults — minimal config is just {}.
 */
export function parseConfig(raw: Record<string, unknown> | undefined): MemoryTdaiConfig {
  const c = raw ?? {};

  // --- Legacy TCVDB config detection (backend removed in refactor) ---
  // Existing user configs may still carry `storeBackend` or a `tcvdb` block.
  // They are silently ignored otherwise; warn loudly because memories stored
  // in TCVDB will not appear in the local SQLite store.
  if ("storeBackend" in c || "tcvdb" in c) {
    const parts: string[] = [];
    if ("storeBackend" in c) parts.push(`storeBackend=${JSON.stringify(c.storeBackend)}`);
    if ("tcvdb" in c) parts.push("tcvdb={...}");
    console.warn(
      `[memory-tdai] Configuration contains legacy TCVDB settings (${parts.join(", ")}) ` +
      `that are no longer supported: the TCVDB vector backend was removed and the plugin ` +
      `now always uses the local SQLite store. Memories previously stored in TCVDB will ` +
      `not be visible. Remove the legacy keys from the plugin config to silence this warning.`,
    );
  }

  // --- Capture (L0) ---
  const captureGroup = obj(c, "capture");

  // --- Retention days validation (from capture.l0l1RetentionDays) ---
  const rawRetentionDays = num(captureGroup, "l0l1RetentionDays") ?? 0;
  const allowAggressiveCleanup = bool(captureGroup, "allowAggressiveCleanup") ?? false;

  let retentionDays: number | undefined;
  if (rawRetentionDays <= 0) {
    retentionDays = undefined;
  } else if (rawRetentionDays >= 3) {
    retentionDays = rawRetentionDays;
  } else if (allowAggressiveCleanup) {
    retentionDays = rawRetentionDays;
  } else {
    retentionDays = undefined;
  }

  // --- Extraction (L1) ---
  const extractionGroup = obj(c, "extraction");

  // --- Persona (L2) ---
  const personaGroup = obj(c, "persona");

  // --- Pipeline ---
  const pipelineGroup = obj(c, "pipeline");

  // Keep pipeline timers within Node's signed 32-bit timeout range. Larger
  // delays are coerced by Node to a near-immediate timer, which could trigger
  // extraction unexpectedly or turn a recurring schedule into a tight loop.
  const maxTimerSeconds = Math.floor(0x7fffffff / 1000);
  const l1IdleTimeoutSeconds = numberInRange(
    num(pipelineGroup, "l1IdleTimeoutSeconds"),
    0,
    maxTimerSeconds,
    600,
  );
  const l2DelayAfterL1Seconds = numberInRange(
    num(pipelineGroup, "l2DelayAfterL1Seconds"),
    0,
    maxTimerSeconds,
    10,
  );
  const l2MinIntervalSeconds = numberInRange(
    num(pipelineGroup, "l2MinIntervalSeconds"),
    0,
    maxTimerSeconds,
    900,
  );
  const configuredL2MaxIntervalSeconds = numberInRange(
    num(pipelineGroup, "l2MaxIntervalSeconds"),
    1,
    maxTimerSeconds,
    3600,
  );
  // The max-interval path does not independently apply the min-interval
  // floor, so enforce the documented relationship at the config boundary.
  const l2MaxIntervalSeconds = Math.max(
    configuredL2MaxIntervalSeconds,
    l2MinIntervalSeconds,
  );

  // --- Recall ---
  const recallGroup = obj(c, "recall");

  // --- Embedding ---
  const embeddingGroup = obj(c, "embedding");
  let embeddingConfigError: string | undefined;

  // Embedding config: determine provider based on user input and apiKey availability
  const embeddingApiKey = str(embeddingGroup, "apiKey") ?? "";
  const embeddingBaseUrl = str(embeddingGroup, "baseUrl") ?? "";
  const embeddingProviderRaw = str(embeddingGroup, "provider") ?? "none";
  const embeddingModelRaw = str(embeddingGroup, "model") ?? "";
  const embeddingDimensionsRaw = num(embeddingGroup, "dimensions");
  const embeddingDimensionsValid =
    embeddingDimensionsRaw != null &&
    Number.isInteger(embeddingDimensionsRaw) &&
    embeddingDimensionsRaw > 0;
  const embeddingProxyUrl = str(embeddingGroup, "proxyUrl");

  // provider="none" → embedding disabled (default for zero-config users)
  // provider="local" → no longer exposed to users; treated as disabled at entry level
  // provider="qclaw" → requires proxyUrl for local proxy forwarding
  // Any other value → remote mode (requires apiKey, baseUrl, model, dimensions)
  let embeddingProvider: string;
  let embeddingEnabled = bool(embeddingGroup, "enabled") ?? true;

  if (embeddingProviderRaw === "none") {
    // Explicitly disabled (default): no embedding, no vector search
    embeddingProvider = "none";
    embeddingEnabled = false;
  } else if (embeddingProviderRaw === "local") {
    // Local embedding is not exposed to users; treat as disabled at entry level.
    // Internal LocalEmbeddingService code is preserved but not reachable from config.
    embeddingProvider = "none";
    embeddingEnabled = false;
    embeddingConfigError =
      "Local embedding provider is not available in user config. " +
      "Please configure a remote embedding provider (e.g. openai, deepseek). Embedding has been disabled.";
  } else if (embeddingProviderRaw === "qclaw") {
    // qclaw provider: requires proxyUrl for local proxy forwarding
    const missingFields: string[] = [];
    if (!embeddingProxyUrl) missingFields.push("proxyUrl");
    if (!embeddingBaseUrl) missingFields.push("baseUrl");
    if (!embeddingApiKey) missingFields.push("apiKey");
    if (!embeddingModelRaw) missingFields.push("model");
    if (!embeddingDimensionsValid) missingFields.push("dimensions (must be a positive integer)");

    if (missingFields.length > 0) {
      const errorMsg =
        `Embedding provider 'qclaw' requires 'proxyUrl', 'baseUrl', 'apiKey', 'model', and 'dimensions' to be set. ` +
        `Missing: ${missingFields.join(", ")}. Embedding has been disabled.`;
      embeddingConfigError = errorMsg;
      embeddingEnabled = false;
      embeddingProvider = embeddingProviderRaw;
    } else {
      embeddingProvider = embeddingProviderRaw;
    }
  } else {
    // Remote mode — validate all required fields
    const missingFields: string[] = [];
    if (!embeddingApiKey) missingFields.push("apiKey");
    if (!embeddingBaseUrl) missingFields.push("baseUrl");
    if (!embeddingModelRaw) missingFields.push("model");
    if (!embeddingDimensionsValid) missingFields.push("dimensions (must be a positive integer)");

    if (missingFields.length > 0) {
      // Configuration error: disable embedding and log detailed error
      // This does NOT throw — the plugin continues running without vector search
      const errorMsg =
        `Remote embedding provider '${embeddingProviderRaw}' requires 'apiKey', 'baseUrl', 'model', and 'dimensions' to be set. ` +
        `Missing: ${missingFields.join(", ")}. Embedding has been disabled.`;
      // We store the error message so the caller (index.ts) can log it
      embeddingConfigError = errorMsg;
      embeddingEnabled = false;
      embeddingProvider = embeddingProviderRaw; // preserve original for error context
    } else {
      embeddingProvider = embeddingProviderRaw;
    }
  }

  // `provider="none"` legitimately omits dimensions, but an explicitly
  // supplied invalid value should still be reported. More importantly, never
  // pass a positive non-integer through to sqlite-vec's `float[N]` schema.
  const isDisabledEmbeddingSentinel =
    embeddingProviderRaw === "none" && embeddingDimensionsRaw === 0;
  if (
    "dimensions" in embeddingGroup &&
    !embeddingDimensionsValid &&
    !isDisabledEmbeddingSentinel
  ) {
    embeddingEnabled = false;
    if (!embeddingConfigError?.includes("positive integer")) {
      const dimensionsError =
        "Embedding 'dimensions' must be a positive integer. Embedding has been disabled.";
      embeddingConfigError = embeddingConfigError
        ? `${embeddingConfigError} ${dimensionsError}`
        : dimensionsError;
    }
  }

  // When provider="none", dimensions=0 signals VectorStore to skip vec0 table
  // creation entirely (deferred until a real embedding provider is configured).
  // This avoids creating vec0 tables with a placeholder dimension that would
  // mismatch if the user later enables a different-dimensional provider.
  const defaultDimensions =
    embeddingProvider === "none" || !embeddingDimensionsValid ? 0 :
    embeddingDimensionsRaw!;
  const defaultModel = embeddingProvider === "none" ? "" : embeddingModelRaw;

  const cleanTime = normalizeCleanTime(str(captureGroup, "cleanTime")) ?? "03:00";

  // --- BM25 (local @tencentdb-agent-memory/tcvdb-text encoder) ---
  const bm25Group = obj(c, "bm25");

  const memoryCleanup: MemoryCleanupConfig = {
    retentionDays,
    enabled: retentionDays != null,
    cleanTime,
  };

  // --- Offload ---
  const offloadGroup = obj(c, "offload");

  const offloadMode: "local" | "backend" | "collect" = (() => {
    const raw = optStr(offloadGroup, "mode");
    if (raw === "local" || raw === "backend" || raw === "collect") return raw;
    return optStr(offloadGroup, "backendUrl") ? "backend" : "local";
  })();

  const offload: OffloadConfig = {
    enabled: bool(offloadGroup, "enabled") ?? false,
    mode: offloadMode,
    model: optStr(offloadGroup, "model"),
    temperature: num(offloadGroup, "temperature") ?? 0.2,
    disableThinking: normalizeDisableThinking(boolOrStr(offloadGroup, "disableThinking")),
    forceTriggerThreshold: num(offloadGroup, "forceTriggerThreshold") ?? 4,
    dataDir: optStr(offloadGroup, "dataDir"),
    defaultContextWindow: num(offloadGroup, "defaultContextWindow") ?? 200000,
    maxPairsPerBatch: num(offloadGroup, "maxPairsPerBatch") ?? 20,
    l2NullThreshold: num(offloadGroup, "l2NullThreshold") ?? 4,
    l2TimeoutSeconds: num(offloadGroup, "l2TimeoutSeconds") ?? 300,
    mildOffloadRatio: num(offloadGroup, "mildOffloadRatio") ?? 0.5,
    aggressiveCompressRatio: num(offloadGroup, "aggressiveCompressRatio") ?? 0.85,
    mmdMaxTokenRatio: num(offloadGroup, "mmdMaxTokenRatio") ?? 0.2,
    backendUrl: optStr(offloadGroup, "backendUrl"),
    backendApiKey: optStr(offloadGroup, "backendApiKey"),
    backendTimeoutMs: num(offloadGroup, "backendTimeoutMs") ?? 120000,
    offloadRetentionDays: normalizeOffloadRetentionDays(num(offloadGroup, "offloadRetentionDays") ?? 0),
    logMaxSizeMb: num(offloadGroup, "logMaxSizeMb") ?? 50,
    userId: optStr(offloadGroup, "userId"),
  };

  return {
    timezone: str(c, "timezone") ?? "system",
    capture: {
      enabled: bool(captureGroup, "enabled") ?? true,
      excludeAgents: strArray(captureGroup, "excludeAgents") ?? [],
      l0l1RetentionDays: retentionDays ?? 0,
      allowAggressiveCleanup,
    },
    extraction: {
      enabled: bool(extractionGroup, "enabled") ?? true,
      enableDedup: bool(extractionGroup, "enableDedup") ?? true,
      maxMemoriesPerSession: positiveInteger(
        num(extractionGroup, "maxMemoriesPerSession"),
        20,
      ),
      model: optStr(extractionGroup, "model"),
    },
    persona: {
      triggerEveryN: num(personaGroup, "triggerEveryN") ?? 50,
      maxScenes: num(personaGroup, "maxScenes") ?? 15,
      backupCount: num(personaGroup, "backupCount") ?? 3,
      sceneBackupCount: num(personaGroup, "sceneBackupCount") ?? 10,
      model: optStr(personaGroup, "model"),
      sceneMaxChars: num(personaGroup, "sceneMaxChars") ?? 2000,
      sceneGrowthLimit: num(personaGroup, "sceneGrowthLimit") ?? 1.5,
      sceneFullRewriteIntervalHours: num(personaGroup, "sceneFullRewriteIntervalHours") ?? 24,
      sceneTtlDays: num(personaGroup, "sceneTtlDays") ?? 30,
      sceneCreateThresholdMemories: num(personaGroup, "sceneCreateThresholdMemories") ?? 5,
      sceneCreateThresholdSessions: num(personaGroup, "sceneCreateThresholdSessions") ?? 3,
      sceneCandidateTtlDays: nonNegativeNumber(
        num(personaGroup, "sceneCandidateTtlDays"),
        30,
      ),
      sceneInjectTopK: num(personaGroup, "sceneInjectTopK") ?? num(personaGroup, "l3InjectTopK") ?? 5,
      sceneInjectSummaryChars: num(personaGroup, "sceneInjectSummaryChars") ?? num(personaGroup, "l3InjectSummaryChars") ?? 150,
      sceneRoutingThreshold: num(personaGroup, "sceneRoutingThreshold") ?? 0.55,
      sceneSummaryMaxChars: num(personaGroup, "sceneSummaryMaxChars") ?? 80,
      sceneSummaryRefreshDays: num(personaGroup, "sceneSummaryRefreshDays") ?? 7,
      sceneSummaryRefreshNewMemories: num(personaGroup, "sceneSummaryRefreshNewMemories") ?? 5,
    },
    pipeline: {
      everyNConversations: num(pipelineGroup, "everyNConversations") ?? 5,
      enableWarmup: bool(pipelineGroup, "enableWarmup") ?? true,
      l1IdleTimeoutSeconds,
      l2DelayAfterL1Seconds,
      l2MinIntervalSeconds,
      l2MaxIntervalSeconds,
      sessionActiveWindowHours: num(pipelineGroup, "sessionActiveWindowHours") ?? 24,
    },
    recall: {
      enabled: bool(recallGroup, "enabled") ?? true,
      maxResults: positiveInteger(num(recallGroup, "maxResults"), 5, 500),
      maxCharsPerMemory: num(recallGroup, "maxCharsPerMemory") ?? 0,
      maxTotalRecallChars: num(recallGroup, "maxTotalRecallChars") ?? 0,
      scoreThreshold: num(recallGroup, "scoreThreshold") ?? 0.55,
      ftsScoreThreshold: num(recallGroup, "ftsScoreThreshold") ?? 0.35,
      minQueryChars: clampMinQueryChars(num(recallGroup, "minQueryChars") ?? 6),
      strategy: validateStrategy(str(recallGroup, "strategy")) ?? "hybrid",
      timeoutMs: num(recallGroup, "timeoutMs") ?? 5000,
      subjectOnly: bool(recallGroup, "subjectOnly") ?? true,
      subjectHintChars: clampSubjectHintChars(num(recallGroup, "subjectHintChars") ?? 60),
      persistToTranscript: bool(recallGroup, "persistToTranscript") ?? true,
    },
    embedding: {
      enabled: embeddingEnabled,
      provider: embeddingProvider,
      baseUrl: embeddingBaseUrl,
      apiKey: embeddingApiKey,
      model: str(embeddingGroup, "model") ?? defaultModel,
      dimensions: defaultDimensions,
      sendDimensions: bool(embeddingGroup, "sendDimensions") ?? true,
      conflictRecallTopK: positiveInteger(
        num(embeddingGroup, "conflictRecallTopK"),
        5,
      ),
      proxyUrl: embeddingProxyUrl,
      maxInputChars: num(embeddingGroup, "maxInputChars") ?? 5000,
      timeoutMs: num(embeddingGroup, "timeoutMs") ?? 10_000,
      recallTimeoutMs: num(embeddingGroup, "recallTimeoutMs") ?? undefined,
      captureTimeoutMs: num(embeddingGroup, "captureTimeoutMs") ?? undefined,
      modelCacheDir: optStr(embeddingGroup, "modelCacheDir"),
      configError: embeddingConfigError,
    },
    bm25: {
      enabled: bool(bm25Group, "enabled") ?? true,
      language: (str(bm25Group, "language") === "en" ? "en" : "zh") as "zh" | "en",
    },
    memoryCleanup,
    report: {
      enabled: bool(obj(c, "report"), "enabled") ?? false,
      type: str(obj(c, "report"), "type") ?? "local",
    },
    llm: (() => {
      const llmGroup = obj(c, "llm");
      return {
        enabled: bool(llmGroup, "enabled") ?? false,
        baseUrl: str(llmGroup, "baseUrl") ?? "https://api.openai.com/v1",
        apiKey: str(llmGroup, "apiKey") ?? "",
        model: str(llmGroup, "model") ?? "gpt-4o",
        maxTokens: num(llmGroup, "maxTokens") ?? 4096,
        timeoutMs: num(llmGroup, "timeoutMs") ?? 120_000,
        disableThinking: normalizeDisableThinking(boolOrStr(llmGroup, "disableThinking")),
      };
    })(),
    offload,
  };
}

// ============================
// Helper functions
// ============================

/** Get sub-object by key, or empty object if missing. */
function obj(c: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = c[key];
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function str(src: Record<string, unknown>, key: string): string | undefined {
  const v = src[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function optStr(src: Record<string, unknown>, key: string): string | undefined {
  const v = src[key];
  return typeof v === "string" ? v : undefined;
}

function num(src: Record<string, unknown>, key: string): number | undefined {
  const v = src[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Resolve a positive integer, optionally clamping it to a defensive cap. */
function positiveInteger(value: number | undefined, fallback: number, max = Infinity): number {
  if (value == null || !Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

/** Resolve a non-negative finite number (zero can be a documented off switch). */
function nonNegativeNumber(value: number | undefined, fallback: number): number {
  return value != null && value >= 0 ? value : fallback;
}

/** Resolve a finite number inside an inclusive range. */
function numberInRange(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  return value != null && value >= min && value <= max ? value : fallback;
}

function bool(src: Record<string, unknown>, key: string): boolean | undefined {
  const v = src[key];
  return typeof v === "boolean" ? v : undefined;
}

/** Read a field that may be boolean or string. */
function boolOrStr(src: Record<string, unknown>, key: string): boolean | string | undefined {
  const v = src[key];
  if (typeof v === "boolean") return v;
  if (typeof v === "string" && v.trim()) return v.trim();
  return undefined;
}

function strArray(src: Record<string, unknown>, key: string): string[] | undefined {
  const v = src[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

const VALID_STRATEGIES: RecallConfig["strategy"][] = ["embedding", "keyword", "hybrid"];

/**
 * Validate recall strategy against whitelist.
 * Returns the strategy if valid, undefined otherwise (caller falls back to default).
 */
function validateStrategy(value: string | undefined): RecallConfig["strategy"] | undefined {
  if (!value) return undefined;
  return VALID_STRATEGIES.includes(value as RecallConfig["strategy"])
    ? (value as RecallConfig["strategy"])
    : undefined;
}

/**
 * Clamp `recall.subjectHintChars` to the valid range `[0, 500]`.
 *
 * Defensive: the plugin JSON schema declares `minimum: 0, maximum: 500`, but
 * users editing `opencode.json` directly can bypass that. Without clamping,
 * a malicious or mistaken value like 100000 could let a single memory hint
 * dominate the entire prompt budget. The clamp keeps hint bounded regardless
 * of how the config was authored.
 *
 * Negative or non-finite values fall back to the default (60).
 */
function clampSubjectHintChars(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 60;
  if (value < 0) return 60;
  return Math.min(Math.floor(value), 500);
}

/**
 * Clamp `recall.minQueryChars` to the valid range `[0, 500]`.
 *
 * Defensive: the plugin JSON schema declares `minimum: 0, maximum: 500`, but
 * users editing `opencode.json` directly can bypass that. Negative or
 * non-finite values fall back to the default (6). The upper bound mirrors
 * `subjectHintChars` to keep config validation uniform - anything above a
 * few hundred chars would block virtually all real queries.
 */
function clampMinQueryChars(value: number | undefined): number {
  if (value == null || !Number.isFinite(value)) return 6;
  if (value < 0) return 6;
  return Math.min(Math.floor(value), 500);
}

/**
 * Normalize a cleanup time string.
 *
 * The input must follow "HH:MM" or "H:MM" format (24-hour clock).
 * If the time is valid, it returns the normalized format "HH:MM"
 * with leading zeros added when necessary.
 * If the format is invalid or the time is out of range
 * (hour: 0–23, minute: 0–59), it returns undefined.
 *
 * Examples:
 * normalizeCleanTime("3:05")  -> "03:05"
 * normalizeCleanTime("03:05") -> "03:05"
 * normalizeCleanTime("23:59") -> "23:59"
 *
 * normalizeCleanTime("24:00") -> undefined   // hour out of range
 * normalizeCleanTime("12:60") -> undefined   // minute out of range
 * normalizeCleanTime("3:5")   -> undefined   // minute must have two digits
 * normalizeCleanTime("abc")   -> undefined   // invalid format
 */
function normalizeCleanTime(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
  if (!m) return undefined;

  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isInteger(hh) || !Number.isInteger(mm)) return undefined;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return undefined;

  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/**
 * Normalize offload retention days.
 *
 * - `<= 0` → 0 (disabled)
 * - `(0, 3)` → 0 (invalid, force disabled)
 * - `>= 3` → as-is
 */
function normalizeOffloadRetentionDays(value: number): number {
  if (value <= 0) return 0;
  if (value < 3) return 0;
  return value;
}

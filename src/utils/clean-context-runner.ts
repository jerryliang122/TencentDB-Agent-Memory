/**
 * CleanContextRunner: executes LLM calls in a fully isolated context
 * through the OpenClaw plugin runtime.
 *
 * Migration note (openclaw ≥ 2026.5): the legacy
 * `runtime.agent.runEmbeddedPiAgent` API and `agents.defaults.systemPromptOverride`
 * config field were removed from OpenClaw. This runner now uses:
 *
 * - enableTools=false → `runtime.llm.complete` with
 *   `execution.mode: "isolated-agent-runtime"` (fresh, zero-tool completion
 *   with full system-prompt control — same pattern as the llm-task extension)
 * - enableTools=true → `runtime.agent.runEmbeddedAgent` with a restricted
 *   tool allow list; the extraction prompt travels via `extraSystemPrompt`
 *
 * Guarantees:
 * 1. Blank conversation history (fresh unique session per run)
 * 2. Independent system prompt (only the task prompt)
 * 3. No tool calls when enableTools=false (isolated completion is zero-tool
 *    by definition; the embedded path passes disableTools:true)
 * 4. No contamination from the main agent's context
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { report } from "../core/report/reporter.js";
import type { Logger } from "../core/types.js";

/**
 * Resolve a preferred temporary directory for memory-tdai operations.
 *
 *   1. Try `/tmp/openclaw` (if writable)
 *   2. Fall back to `os.tmpdir()/openclaw-<uid>`
 */
function resolveOpenClawTmpDir(): string {
  const POSIX_DIR = "/tmp/openclaw";
  try {
    if (fsSync.existsSync(POSIX_DIR)) {
      fsSync.accessSync(POSIX_DIR, fsSync.constants.W_OK | fsSync.constants.X_OK);
      return POSIX_DIR;
    }
    // Try to create it
    fsSync.mkdirSync(POSIX_DIR, { recursive: true, mode: 0o700 });
    return POSIX_DIR;
  } catch {
    // Fall back to os.tmpdir()
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    const suffix = uid === undefined ? "openclaw" : `openclaw-${uid}`;
    const fallback = path.join(os.tmpdir(), suffix);
    fsSync.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

const TAG = "[memory-tdai] [runner]";

type RunnerLogger = Logger;

// ── Plugin runtime seam ──
// Structural subset of `OpenClawPluginApi["runtime"]` — the exact surface this
// runner calls. Declared locally so the module stays typecheckable without the
// openclaw package installed (it is a peer dependency, resolved by the host).

export interface LlmCompleteCallParams {
  messages: [{ role: "user"; content: string }];
  systemPrompt?: string;
  /** Model ref (e.g. "anthropic/claude-sonnet-4-6"); defaults to the agent's model. */
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  purpose?: string;
  execution: {
    mode: "isolated-agent-runtime";
    authProfileId?: string;
    timeoutMs?: number;
  };
}

export interface LlmCompleteCallResult {
  text: string;
  provider: string;
  model: string;
}

export interface RunEmbeddedAgentCallParams {
  sessionId: string;
  runId: string;
  sessionKey?: string;
  workspaceDir: string;
  config?: Record<string, unknown>;
  prompt: string;
  timeoutMs: number;
  provider?: string;
  model?: string;
  disableTools?: boolean;
  extraSystemPrompt?: string;
  streamParams?: { maxTokens?: number };
  /** What initiated this agent run: "user" | "heartbeat" | "cron" | "memory" | "overflow" | "manual". */
  trigger?: string;
}

export interface RunEmbeddedAgentCallResult {
  payloads?: Array<{ text?: string; isError?: boolean } | undefined>;
}

export interface PluginRuntimeLike {
  llm?: { complete?: (params: LlmCompleteCallParams) => Promise<LlmCompleteCallResult> };
  agent?: { runEmbeddedAgent?: (params: RunEmbeddedAgentCallParams) => Promise<RunEmbeddedAgentCallResult> };
}

let _preferredRuntime: PluginRuntimeLike | undefined;

/**
 * Register the host-provided plugin runtime (usually `api.runtime`).
 * Called once at plugin registration; the stored runtime is used when a
 * runner is constructed without an explicit `agentRuntime`.
 */
export function setPreferredPluginRuntime(runtime: PluginRuntimeLike | undefined): void {
  _preferredRuntime = runtime;
}

function resolveRuntime(agentRuntime?: PluginRuntimeLike): PluginRuntimeLike | undefined {
  const candidate = agentRuntime ?? _preferredRuntime;
  if (!candidate) return undefined;
  const hasLlm = typeof candidate.llm?.complete === "function";
  const hasAgent = typeof candidate.agent?.runEmbeddedAgent === "function";
  return hasLlm || hasAgent ? candidate : undefined;
}

function collectText(payloads: RunEmbeddedAgentCallResult["payloads"]): string {
  const texts = (payloads ?? [])
    .filter((p): p is { text?: string; isError?: boolean } => !!p && !p.isError && typeof p.text === "string")
    .map((p) => p.text ?? "");
  return texts.join("\n").trim();
}

// ── Model resolution utilities ──

/** Parsed model reference: { provider, model } */
export interface ModelRef {
  provider: string;
  model: string;
}

/**
 * Parse a "provider/model" string into its components.
 * Returns undefined if the input is empty or doesn't contain a "/".
 *
 * Examples:
 *   "azure/gpt-5.2-chat"          → { provider: "azure", model: "gpt-5.2-chat" }
 *   "custom-host/org/model-v2"    → { provider: "custom-host", model: "org/model-v2" }
 *   ""                            → undefined
 *   "bare-model-name"             → undefined (no "/" — may be an alias)
 */
export function parseModelRef(raw: string | undefined): ModelRef | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const slashIdx = trimmed.indexOf("/");
  if (slashIdx <= 0 || slashIdx === trimmed.length - 1) return undefined;

  return {
    provider: trimmed.slice(0, slashIdx),
    model: trimmed.slice(slashIdx + 1),
  };
}

/**
 * Resolve the user's default model from the main OpenClaw config.
 *
 * Resolution order:
 * 1. Read `agents.defaults.model` (string or { primary })
 * 2. If the value contains "/", parse directly
 * 3. If not (may be an alias), look up in `agents.defaults.models` alias table
 * 4. Return undefined if nothing resolves — let the core use its built-in default
 */
export function resolveModelFromMainConfig(config: unknown): ModelRef | undefined {
  if (!config || typeof config !== "object") return undefined;

  const cfg = config as Record<string, unknown>;
  const agents = cfg.agents as Record<string, unknown> | undefined;
  if (!agents || typeof agents !== "object") return undefined;

  const defaults = agents.defaults as Record<string, unknown> | undefined;
  if (!defaults || typeof defaults !== "object") return undefined;

  // Step 1: extract raw model value (string | { primary?: string })
  const modelCfg = defaults.model;
  let raw: string | undefined;
  if (typeof modelCfg === "string") {
    raw = modelCfg.trim();
  } else if (modelCfg && typeof modelCfg === "object") {
    const primary = (modelCfg as Record<string, unknown>).primary;
    raw = typeof primary === "string" ? primary.trim() : undefined;
  }
  if (!raw) return undefined;

  // Step 2: try direct "provider/model" parse
  const direct = parseModelRef(raw);
  if (direct) return direct;

  // Step 3: alias lookup — raw doesn't contain "/", check agents.defaults.models
  const models = defaults.models as Record<string, unknown> | undefined;
  if (!models || typeof models !== "object") return undefined;

  const rawLower = raw.toLowerCase();
  for (const [key, entry] of Object.entries(models)) {
    if (!entry || typeof entry !== "object") continue;
    const alias = (entry as Record<string, unknown>).alias;
    if (typeof alias !== "string") continue;
    if (alias.trim().toLowerCase() !== rawLower) continue;

    // key is "provider/model" format
    const resolved = parseModelRef(key);
    if (resolved) return resolved;
  }

  return undefined;
}

export interface CleanContextRunnerOptions {
  config: unknown; // OpenClawConfig
  provider?: string;
  model?: string;
  /**
   * Convenience field: full "provider/model" string.
   * Takes precedence over separate `provider`/`model` fields.
   * When all three (modelRef, provider, model) are omitted,
   * automatically falls back to the main config's `agents.defaults.model`.
   */
  modelRef?: string;
  /** Host plugin runtime seam (`api.runtime`). Required at run time. */
  agentRuntime?: PluginRuntimeLike;
  /** Allow the LLM to use tools (read_file, write_to_file, etc). Default: false */
  enableTools?: boolean;
  /** Logger instance for detailed tracing */
  logger?: RunnerLogger;
}

const DEFAULT_EXTRACTION_SYSTEM_PROMPT =
  "You are a precise data extraction and generation assistant. Follow the user instructions exactly. Respond only with the requested output format.";

// Stable empty directory used as default workspaceDir so that:
// 1. Bootstrap/skills scans find nothing → clean LLM context
// 2. The path is constant → plugin cacheKey stays stable (no re-registration)
let _cleanWorkspaceDir: string | undefined;
async function getCleanWorkspaceDir(): Promise<string> {
  if (_cleanWorkspaceDir) return _cleanWorkspaceDir;
  const dir = path.join(resolveOpenClawTmpDir(), "memory-tdai-clean-workspace");
  await fs.mkdir(dir, { recursive: true });
  _cleanWorkspaceDir = dir;
  return dir;
}

export class CleanContextRunner {
  private options: CleanContextRunnerOptions;
  private logger: RunnerLogger | undefined;
  /** Resolved provider after modelRef / config fallback */
  private resolvedProvider: string | undefined;
  /** Resolved model after modelRef / config fallback */
  private resolvedModel: string | undefined;

  constructor(options: CleanContextRunnerOptions) {
    this.options = options;
    this.logger = options.logger;

    // Model resolution priority:
    // 1. modelRef ("provider/model" string)  — highest
    // 2. explicit provider + model fields
    // 3. main config agents.defaults.model   — automatic fallback
    // 4. undefined (let core use built-in default)
    const fromRef = parseModelRef(options.modelRef);
    if (fromRef) {
      this.resolvedProvider = fromRef.provider;
      this.resolvedModel = fromRef.model;
    } else if (options.provider || options.model) {
      this.resolvedProvider = options.provider;
      this.resolvedModel = options.model;
    } else {
      // No explicit model specified — fall back to main config
      const fromConfig = resolveModelFromMainConfig(options.config);
      if (fromConfig) {
        this.resolvedProvider = fromConfig.provider;
        this.resolvedModel = fromConfig.model;
        this.logger?.debug?.(
          `${TAG} Using model from main config: ${fromConfig.provider}/${fromConfig.model}`,
        );
      }
      // else: both undefined → core will use its built-in default
    }
  }

  /**
   * Run a prompt in a fully isolated clean context.
   * Returns the LLM's text output.
   *
   * When `workspaceDir` is provided it overrides the default clean workspace,
   * letting the LLM's file-tool calls resolve paths relative to a custom root
   * (embedded-agent path only).
   */
  async run(params: {
    prompt: string;
    /** Task-specific system prompt. Defaults to a generic extraction prompt. */
    systemPrompt?: string;
    taskId: string;
    timeoutMs?: number;
    maxTokens?: number;
    workspaceDir?: string;
    /** Plugin instance ID for llm_call metric (optional) */
    instanceId?: string;
  }): Promise<string> {
    const runStartMs = Date.now();
    const timeoutMs = params.timeoutMs ?? 120_000;
    const systemPrompt = params.systemPrompt || DEFAULT_EXTRACTION_SYSTEM_PROMPT;
    this.logger?.debug?.(
      `${TAG} run() start: taskId=${params.taskId}, timeout=${timeoutMs}ms, ` +
      `tools=${this.options.enableTools ? "enabled" : "disabled"}, ` +
      `model=${this.resolvedModel ? `${this.resolvedProvider ?? "(default)"}/${this.resolvedModel}` : "(default)"}`,
    );

    const runtime = resolveRuntime(this.options.agentRuntime);
    if (!runtime) {
      throw new Error(
        `${TAG} No OpenClaw plugin runtime available for LLM calls ` +
        `(runtime.llm.complete / runtime.agent.runEmbeddedAgent missing). ` +
        `Ensure the plugin runs inside a current OpenClaw host, or configure the ` +
        `standalone LLM override (llm.enabled + llm.apiKey) in the memory-tdai config.`,
      );
    }

    try {
      let text: string;
      if (!this.options.enableTools && typeof runtime.llm?.complete === "function") {
        text = await this.runIsolatedCompletion(runtime, { ...params, systemPrompt, timeoutMs });
      } else if (typeof runtime.agent?.runEmbeddedAgent === "function") {
        text = await this.runEmbeddedAgent(runtime, { ...params, systemPrompt, timeoutMs });
      } else {
        throw new Error(
          `${TAG} OpenClaw runtime does not expose ${
            this.options.enableTools ? "agent.runEmbeddedAgent" : "llm.complete"
          }; cannot run taskId=${params.taskId}. Configure the standalone LLM override ` +
          `(llm.enabled + llm.apiKey) in the memory-tdai config.`,
        );
      }

      const totalMs = Date.now() - runStartMs;

      if (!text) {
        // Empty output is normal when the LLM decides there is nothing to
        // extract (e.g. trivial greetings).  Log a warning instead of
        // throwing so the caller can handle it gracefully.
        this.logger?.warn?.(
          `${TAG} run() empty output after ${totalMs}ms — treating as empty result`,
        );
        this.reportMetric(params, totalMs, 0, true, "empty_output");
        return "";
      }

      this.logger?.debug?.(
        `${TAG} run() completed: ${totalMs}ms total, output=${text.length} chars`,
      );
      this.reportMetric(params, totalMs, text.length, true, null);
      return text;
    } catch (err) {
      const totalMs = Date.now() - runStartMs;
      this.logger?.error(
        `${TAG} run() failed after ${totalMs}ms: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
      this.reportMetric(params, totalMs, 0, false, err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  /** L1 path: fresh zero-tool completion with full system-prompt control. */
  private async runIsolatedCompletion(
    runtime: PluginRuntimeLike,
    params: {
      prompt: string;
      systemPrompt: string;
      taskId: string;
      timeoutMs: number;
      maxTokens?: number;
    },
  ): Promise<string> {
    const modelRef =
      this.resolvedProvider && this.resolvedModel
        ? `${this.resolvedProvider}/${this.resolvedModel}`
        : undefined;
    this.logger?.debug?.(
      `${TAG} [l1-debug] INVOKE llm.complete taskId=${params.taskId}, ` +
      `model=${modelRef ?? "(default)"}, promptLen=${params.prompt.length}, ` +
      `sysPromptLen=${params.systemPrompt.length}, timeoutMs=${params.timeoutMs}`,
    );

    const result = await runtime.llm!.complete!({
      messages: [{ role: "user", content: params.prompt }],
      systemPrompt: params.systemPrompt,
      ...(modelRef ? { model: modelRef } : {}),
      ...(params.maxTokens ? { maxTokens: params.maxTokens } : {}),
      purpose: `memory-tdai:${params.taskId}`,
      execution: {
        mode: "isolated-agent-runtime",
        timeoutMs: params.timeoutMs,
      },
    });

    return (result.text ?? "").trim();
  }

  /** L2 path: embedded agent run with a restricted, sandboxed tool set. */
  private async runEmbeddedAgent(
    runtime: PluginRuntimeLike,
    params: {
      prompt: string;
      systemPrompt: string;
      taskId: string;
      timeoutMs: number;
      maxTokens?: number;
      workspaceDir?: string;
    },
  ): Promise<string> {
    const workspaceDir = params.workspaceDir ?? (await getCleanWorkspaceDir());

    // Derive a config with plugins disabled to prevent loadOpenClawPlugins
    // from re-registering plugins when the workspaceDir differs from the
    // gateway's original workspace (cacheKey mismatch triggers full reload).
    //
    // Security: restrict available tools to the minimal set needed for
    // scene extraction (read/write/edit). This prevents the LLM from
    // accessing exec, sessions, browser, cron, or any other powerful tools.
    const baseConfig = (this.options.config as Record<string, unknown>) ?? {};
    const cleanConfig = {
      ...baseConfig,
      plugins: {
        ...(baseConfig.plugins as Record<string, unknown> | undefined),
        enabled: false,
      },
      tools: {
        ...(baseConfig.tools as Record<string, unknown> | undefined),
        // When enableTools=true, restrict to the minimal set needed for
        // scene extraction (read/write/edit).
        // When enableTools=false, pass an empty allow list — disableTools:true
        // will prevent tools from being sent to the API entirely.
        allow: this.options.enableTools ? ["read", "write", "edit"] : [],
      },
    };

    const ts = Date.now();
    const sessionId = `memory-${params.taskId}-session-${ts}`;
    const sessionKey = sessionId; // fresh unique key → blank transcript
    const runId = `memory-${params.taskId}-run-${ts}`;

    this.logger?.debug?.(
      `${TAG} [l1-debug] INVOKE runEmbeddedAgent taskId=${params.taskId}, ` +
      `sessionId=${sessionId}, provider=${this.resolvedProvider ?? "(default)"}, ` +
      `model=${this.resolvedModel ?? "(default)"}, promptLen=${params.prompt.length}, ` +
      `extraSystemPromptLen=${params.systemPrompt.length}, workspaceDir=${workspaceDir}, ` +
      `timeoutMs=${params.timeoutMs}`,
    );

    const result = await runtime.agent!.runEmbeddedAgent!({
      sessionId,
      sessionKey,
      runId,
      workspaceDir,
      config: cleanConfig,
      prompt: params.prompt,
      timeoutMs: params.timeoutMs,
      ...(this.resolvedProvider ? { provider: this.resolvedProvider } : {}),
      ...(this.resolvedModel ? { model: this.resolvedModel } : {}),
      // When enableTools=false, pass disableTools:true so that no tool
      // definitions are sent to the API.
      disableTools: !this.options.enableTools,
      extraSystemPrompt: params.systemPrompt,
      streamParams: {
        maxTokens: params.maxTokens,
      },
      trigger: "memory",
    });

    return collectText(result?.payloads);
  }

  private reportMetric(
    params: { taskId: string; prompt: string; instanceId?: string },
    totalDurationMs: number,
    outputLength: number,
    success: boolean,
    error: string | null,
  ): void {
    if (!params.instanceId) return;
    report("llm_call", {
      taskId: params.taskId,
      provider: this.resolvedProvider ?? "default",
      model: this.resolvedModel ?? "default",
      inputLength: params.prompt.length,
      outputLength,
      totalDurationMs,
      success,
      error,
    });
  }
}

/**
 * Scene Synthesizer: the only LLM touchpoints in the v2 L2 flow.
 *
 *   promote(samples)      → { title, summary } for a new scene block
 *   refreshSummary(...)   → regenerated one-line current-state summary
 *
 * Every output is validated, sanitized and truncated by engineering before
 * it reaches a file. When the LLM is unavailable or returns garbage, both
 * methods degrade to deterministic derivation from the memory samples —
 * L2 keeps working (slightly blunter titles/summaries) with zero LLM.
 */

import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import {
  buildPromotionUserPrompt,
  buildRefreshUserPrompt,
  parseSynthesisJson,
  PROMOTION_SYSTEM_PROMPT,
  REFRESH_SYSTEM_PROMPT,
  type SceneSynthesisSample,
} from "../prompts/scene-synthesis.js";
import { capSceneSummary, sanitizeSceneFilenameStem } from "./scene-format.js";
import type { LLMRunner, Logger } from "../types.js";

export interface SceneSynthesizerOptions {
  /** OpenClaw config (CleanContextRunner fallback path). */
  config?: unknown;
  /** Model override. */
  model?: string;
  /** Host-neutral LLM runner (standalone/gateway mode). */
  llmRunner?: LLMRunner;
  logger?: Logger;
  /** Hard cap for summaries (engineering-enforced). */
  summaryMaxChars?: number;
}

const CALL_TIMEOUT_MS = 60_000;

export class SceneSynthesizer {
  private readonly runner: LLMRunner;
  private readonly logger?: Logger;
  private readonly summaryMaxChars: number;

  constructor(opts: SceneSynthesizerOptions) {
    this.logger = opts.logger;
    this.summaryMaxChars = opts.summaryMaxChars ?? 80;
    this.runner = opts.llmRunner ?? new CleanContextRunner({
      config: opts.config,
      modelRef: opts.model,
      enableTools: false,
      logger: opts.logger,
    });
  }

  /**
   * Synthesize title + summary for a newly promoted scene.
   * Falls back to deriving both from the newest memory sample.
   */
  async promote(
    samples: SceneSynthesisSample[],
  ): Promise<{ title: string; summary: string; degraded: boolean }> {
    const fallbackHead = samples[samples.length - 1]?.head ?? "";
    const fallback = {
      title: sanitizeSceneFilenameStem(truncateChars(fallbackHead, 24)) || "scene",
      summary: capSceneSummary(fallbackHead, this.summaryMaxChars),
      degraded: true,
    };
    if (samples.length === 0) return fallback;

    try {
      const raw = await this.runner.run({
        systemPrompt: PROMOTION_SYSTEM_PROMPT,
        prompt: buildPromotionUserPrompt(samples),
        taskId: "scene-promote",
        timeoutMs: CALL_TIMEOUT_MS,
      });
      const parsed = parseSynthesisJson(raw);
      const title = parsed?.title;
      const summary = parsed?.summary;
      if (!title && !summary) return fallback;
      return {
        title: sanitizeSceneFilenameStem(truncateChars(title || fallback.title, 40)),
        summary: capSceneSummary(summary || fallback.summary, this.summaryMaxChars),
        degraded: !title || !summary,
      };
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][synthesizer] promote LLM call failed, using derived title/summary: ${err instanceof Error ? err.message : String(err)}`,
      );
      return fallback;
    }
  }

  /**
   * Regenerate a scene's current-state summary after merging new memories.
   * Falls back to the newest sample head (fresh beats stale).
   */
  async refreshSummary(
    title: string,
    oldSummary: string,
    newHeads: SceneSynthesisSample[],
  ): Promise<{ summary: string; degraded: boolean }> {
    const newestHead = newHeads[newHeads.length - 1]?.head ?? "";
    const fallback = { summary: capSceneSummary(newestHead || oldSummary, this.summaryMaxChars), degraded: true };
    if (newHeads.length === 0) return { summary: capSceneSummary(oldSummary, this.summaryMaxChars), degraded: false };

    try {
      const raw = await this.runner.run({
        systemPrompt: REFRESH_SYSTEM_PROMPT,
        prompt: buildRefreshUserPrompt(title, oldSummary, newHeads),
        taskId: "scene-refresh",
        timeoutMs: CALL_TIMEOUT_MS,
      });
      const parsed = parseSynthesisJson(raw);
      if (!parsed?.summary) return fallback;
      return { summary: capSceneSummary(parsed.summary, this.summaryMaxChars), degraded: false };
    } catch (err) {
      this.logger?.warn?.(
        `[memory-tdai][synthesizer] refresh LLM call failed, using newest sample head: ${err instanceof Error ? err.message : String(err)}`,
      );
      return fallback;
    }
  }
}

function truncateChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join("");
}

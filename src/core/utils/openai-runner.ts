/**
 * Simple OpenAI-compatible LLM runner for standalone usage.
 */

import type { LLMRunner, LLMRunParams } from "../types.js";
import type { DisableThinkingStrategy } from "../../utils/no-think-fetch.js";
import { createNoThinkFetch } from "../../utils/no-think-fetch.js";

export interface OpenAICompatibleRunnerOptions {
  baseUrl?: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  disableThinking?: DisableThinkingStrategy;
  /** Max retries after the initial attempt for transient failures. Default: 2. */
  maxRetries?: number;
  /** Base backoff delay for retries (doubles per attempt). Default: 500ms. */
  retryBaseDelayMs?: number;
}

const TRANSIENT_STATUS = new Set([429, 500, 502, 503, 504]);

/** Non-retryable failure (4xx client errors, malformed responses). */
class NonRetryableError extends Error {}

export function createOpenAICompatibleRunner(opts: OpenAICompatibleRunnerOptions): LLMRunner {
  const baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = opts.model;
  const defaultMaxTokens = opts.maxTokens ?? 4096;
  const defaultTimeoutMs = opts.timeoutMs ?? 60000;
  const disableThinking = opts.disableThinking ?? false;
  const maxRetries = opts.maxRetries ?? 2;
  const retryBaseDelayMs = opts.retryBaseDelayMs ?? 500;

  const noThinkFetch = disableThinking
    ? createNoThinkFetch(disableThinking)
    : undefined;

  return {
    async run(params: LLMRunParams): Promise<string> {
      const messages: Array<{ role: string; content: string }> = [];

      if (params.systemPrompt) {
        messages.push({ role: "system", content: params.systemPrompt });
      }
      messages.push({ role: "user", content: params.prompt });

      const maxTokens = params.maxTokens ?? defaultMaxTokens;
      const timeoutMs = params.timeoutMs ?? defaultTimeoutMs;

      const body: Record<string, unknown> = {
        model,
        messages,
        max_tokens: maxTokens,
      };

      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const fetchFn = noThinkFetch ?? fetch;
          const response = await fetchFn(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${opts.apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!response.ok) {
            const text = await response.text();
            if (TRANSIENT_STATUS.has(response.status)) {
              lastError = new Error(`LLM API error: ${response.status} ${text}`);
            } else {
              throw new NonRetryableError(`LLM API error: ${response.status} ${text}`);
            }
          } else {
            const data = await response.json() as {
              choices: Array<{
                message: {
                  role: string;
                  content?: string;
                };
              }>;
            };

            const choice = data.choices[0];
            if (!choice) {
              throw new NonRetryableError("No choices in LLM response");
            }

            return choice.message.content ?? "";
          }
        } catch (err) {
          if (err instanceof NonRetryableError) {
            throw err;
          }
          // Network errors and transient failures are retried.
          lastError = err;
        } finally {
          clearTimeout(timeoutId);
        }

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryBaseDelayMs * 2 ** attempt));
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error(`LLM request failed after ${maxRetries + 1} attempts`);
    },
  };
}

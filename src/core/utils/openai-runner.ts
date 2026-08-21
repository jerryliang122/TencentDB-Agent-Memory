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
  enableTools?: boolean;
  disableThinking?: DisableThinkingStrategy;
}

export function createOpenAICompatibleRunner(opts: OpenAICompatibleRunnerOptions): LLMRunner {
  const baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
  const model = opts.model;
  const defaultMaxTokens = opts.maxTokens ?? 4096;
  const defaultTimeoutMs = opts.timeoutMs ?? 60000;
  const enableTools = opts.enableTools ?? false;
  const disableThinking = opts.disableThinking ?? false;

  const noThinkFetch = disableThinking
    ? createNoThinkFetch({ strategy: disableThinking })
    : null;

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
          throw new Error(`LLM API error: ${response.status} ${text}`);
        }

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
          throw new Error("No choices in LLM response");
        }

        return choice.message.content ?? "";
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

/**
 * Simple OpenAI-compatible LLM runner for standalone usage.
 */

import type { LLMRunner } from "./types.js";

export interface OpenAICompatibleRunnerOptions {
  baseUrl?: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  enableTools?: boolean;
}

export function createOpenAICompatibleRunner(opts: OpenAICompatibleRunnerOptions): LLMRunner {
  const baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
  const model = opts.model;
  const maxTokens = opts.maxTokens ?? 4096;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const enableTools = opts.enableTools ?? false;

  return {
    async run(params) {
      const messages = params.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
      }));

      const body: Record<string, unknown> = {
        model,
        messages,
        max_tokens: maxTokens,
      };

      if (params.tools && enableTools) {
        body.tools = params.tools;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
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
              tool_calls?: Array<{
                id: string;
                function: { name: string; arguments: string };
              }>;
            };
          }>;
        };

        const choice = data.choices[0];
        if (!choice) {
          throw new Error("No choices in LLM response");
        }

        return {
          role: choice.message.role as "assistant",
          content: choice.message.content ?? "",
          toolCalls: choice.message.tool_calls?.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments),
          })),
        };
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

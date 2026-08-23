import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateTextMock(...args),
  stepCountIs: (n: number) => ({ type: "stepCount", count: n }),
  tool: (t: unknown) => t,
  jsonSchema: (s: unknown) => s,
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: () => ({
    chat: (model: string) => ({ modelId: model, provider: "mock-openai" }),
  }),
}));

import { StandaloneLLMRunner } from "./standalone-llm-runner.js";

function makeRunner(configOverrides: Record<string, unknown> = {}) {
  return new StandaloneLLMRunner({
    config: {
      baseUrl: "http://localhost:1/v1",
      apiKey: "test-key",
      model: "test-model",
      ...configOverrides,
    },
  });
}

describe("StandaloneLLMRunner", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    generateTextMock.mockResolvedValue({
      text: "ok",
      steps: [{ toolCalls: [] }],
    });
  });

  it("passes maxTokens to generateText as maxOutputTokens (ai@6 option name)", async () => {
    const runner = makeRunner({ maxTokens: 1234 });
    await runner.run({ prompt: "hello", taskId: "test-task" });

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const callArgs = generateTextMock.mock.calls[0][0];
    expect(callArgs.maxOutputTokens).toBe(1234);
    expect(callArgs).not.toHaveProperty("maxTokens");
  });

  it("uses param-level maxTokens over config-level", async () => {
    const runner = makeRunner({ maxTokens: 1000 });
    await runner.run({ prompt: "hello", maxTokens: 777, taskId: "test-task" });

    const callArgs = generateTextMock.mock.calls[0][0];
    expect(callArgs.maxOutputTokens).toBe(777);
  });

  it("applies default maxTokens of 4096 when neither param nor config sets it", async () => {
    const runner = makeRunner();
    await runner.run({ prompt: "hello", taskId: "test-task" });

    const callArgs = generateTextMock.mock.calls[0][0];
    expect(callArgs.maxOutputTokens).toBe(4096);
  });
});

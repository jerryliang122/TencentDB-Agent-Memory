import { describe, it, expect, vi, beforeEach } from "vitest";

import { CleanContextRunner, parseModelRef, resolveModelFromMainConfig } from "./clean-context-runner.js";

function makeRuntime() {
  return {
    llm: { complete: vi.fn() },
    agent: { runEmbeddedAgent: vi.fn() },
  };
}

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe("CleanContextRunner (current OpenClaw runtime API)", () => {
  it("uses runtime.llm.complete isolated-agent-runtime for text-only runs (enableTools=false)", async () => {
    const runtime = makeRuntime();
    runtime.llm.complete.mockResolvedValue({
      text: "  extracted memory  ",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      agentId: "a1",
      usage: {},
      execution: { mode: "isolated-agent-runtime", owner: { kind: "harness", id: "x" } },
      audit: { caller: { kind: "plugin" } },
    });

    const runner = new CleanContextRunner({
      config: { agents: { defaults: { model: "anthropic/claude-sonnet-4-6" } } },
      enableTools: false,
      agentRuntime: runtime as never,
      logger,
    });

    const text = await runner.run({
      prompt: "extract memories from this conversation",
      systemPrompt: "You are an extraction assistant.",
      taskId: "l1-extraction",
      maxTokens: 2048,
      timeoutMs: 30_000,
    });

    expect(text).toBe("extracted memory");
    expect(runtime.llm.complete).toHaveBeenCalledTimes(1);
    const call = runtime.llm.complete.mock.calls[0][0];
    expect(call.messages).toEqual([
      { role: "user", content: "extract memories from this conversation" },
    ]);
    expect(call.systemPrompt).toBe("You are an extraction assistant.");
    expect(call.model).toBe("anthropic/claude-sonnet-4-6");
    expect(call.maxTokens).toBe(2048);
    expect(call.execution).toEqual({ mode: "isolated-agent-runtime", timeoutMs: 30_000 });
    expect(runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("uses runtime.agent.runEmbeddedAgent with extraSystemPrompt for tool runs (enableTools=true)", async () => {
    const runtime = makeRuntime();
    runtime.agent.runEmbeddedAgent.mockResolvedValue({
      payloads: [
        { text: "ignored error", isError: true },
        { text: "scene result" },
      ],
      meta: {},
    });

    const runner = new CleanContextRunner({
      config: { some: "config" },
      modelRef: "deepseek/deepseek-chat",
      enableTools: true,
      agentRuntime: runtime as never,
      logger,
    });

    const text = await runner.run({
      prompt: "update scene blocks",
      systemPrompt: "You are a scene extraction assistant.",
      taskId: "l2-scene",
      maxTokens: 4096,
      workspaceDir: "/tmp/scene-workspace",
    });

    expect(text).toBe("scene result");
    expect(runtime.agent.runEmbeddedAgent).toHaveBeenCalledTimes(1);
    const call = runtime.agent.runEmbeddedAgent.mock.calls[0][0];

    // System prompt travels via extraSystemPrompt (systemPromptOverride was
    // removed from OpenClaw config).
    expect(call.extraSystemPrompt).toBe("You are a scene extraction assistant.");
    expect(call.provider).toBe("deepseek");
    expect(call.model).toBe("deepseek-chat");
    expect(call.disableTools).toBe(false);
    expect(call.workspaceDir).toBe("/tmp/scene-workspace");
    expect(call.timeoutMs).toBe(120_000);
    expect(call.streamParams).toEqual({ maxTokens: 4096 });
    expect(typeof call.sessionId).toBe("string");
    expect(typeof call.runId).toBe("string");
    expect(call.trigger).toBe("memory");

    const cfg = call.config;
    expect(cfg.plugins.enabled).toBe(false);
    expect(cfg.tools.allow).toEqual(["read", "write", "edit"]);
    const defaults = cfg.agents?.defaults ?? {};
    expect("systemPromptOverride" in defaults).toBe(false);
    expect(runtime.llm.complete).not.toHaveBeenCalled();
  });

  it("restricts tools to an empty allow list when enableTools=false via embedded agent path", async () => {
    // Even though the L1 path uses llm.complete today, the config construction
    // for an embedded-agent run with enableTools=false must not allow tools.
    const runtime = makeRuntime();
    runtime.agent.runEmbeddedAgent.mockResolvedValue({ payloads: [{ text: "ok" }], meta: {} });

    const runner = new CleanContextRunner({
      config: {},
      enableTools: false,
      // Force the embedded path by omitting llm from the runtime
      agentRuntime: { agent: runtime.agent } as never,
      logger,
    });

    await runner.run({ prompt: "p", taskId: "t" });

    const call = runtime.agent.runEmbeddedAgent.mock.calls[0][0];
    expect(call.disableTools).toBe(true);
    expect(call.config.tools.allow).toEqual([]);
  });

  it("throws an actionable error when no runtime is available", async () => {
    const runner = new CleanContextRunner({ config: {}, logger });
    await expect(runner.run({ prompt: "p", taskId: "t" })).rejects.toThrow(/standalone LLM/i);
  });

  it("falls back to the generic extraction system prompt when none is provided", async () => {
    const runtime = makeRuntime();
    runtime.llm.complete.mockResolvedValue({
      text: "ok",
      provider: "p",
      model: "m",
      agentId: "a",
      usage: {},
      execution: { mode: "isolated-agent-runtime", owner: { kind: "harness", id: "x" } },
      audit: { caller: { kind: "plugin" } },
    });

    const runner = new CleanContextRunner({
      config: {},
      agentRuntime: runtime as never,
      logger,
    });

    await runner.run({ prompt: "p", taskId: "t" });

    const call = runtime.llm.complete.mock.calls[0][0];
    expect(call.systemPrompt).toMatch(/precise data extraction and generation assistant/i);
  });
});

describe("parseModelRef / resolveModelFromMainConfig", () => {
  it("parses provider/model strings", () => {
    expect(parseModelRef("azure/gpt-5.2-chat")).toEqual({ provider: "azure", model: "gpt-5.2-chat" });
    expect(parseModelRef("custom-host/org/model-v2")).toEqual({ provider: "custom-host", model: "org/model-v2" });
    expect(parseModelRef("")).toBeUndefined();
    expect(parseModelRef("bare-model")).toBeUndefined();
  });

  it("resolves the default model from the main config, including alias entries", () => {
    expect(
      resolveModelFromMainConfig({ agents: { defaults: { model: "anthropic/claude-sonnet-4-6" } } }),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-4-6" });

    expect(
      resolveModelFromMainConfig({
        agents: {
          defaults: {
            model: "fast",
            models: {
              "groq/llama-3.3-70b": { alias: "fast" },
            },
          },
        },
      }),
    ).toEqual({ provider: "groq", model: "llama-3.3-70b" });
  });
});

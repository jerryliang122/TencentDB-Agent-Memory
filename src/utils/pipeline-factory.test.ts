import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const createOpenAICompatibleRunnerMock = vi.fn(() => ({ run: async () => "l1-stub" }));
// Regular function (not arrow) so the mock can be invoked with `new`.
const standaloneCtorMock = vi.fn(function StandaloneLLMRunnerStub() {
  return { run: async () => "l2-stub" };
});

vi.mock("../core/utils/openai-runner.js", () => ({
  createOpenAICompatibleRunner: createOpenAICompatibleRunnerMock,
}));

vi.mock("../core/utils/standalone-llm-runner.js", () => ({
  StandaloneLLMRunner: standaloneCtorMock,
}));

import { parseConfig } from "../config.js";
import { MemoryPipelineManager } from "./pipeline-manager.js";
import { createL1Runner, createPipeline } from "./pipeline-factory.js";
import { CheckpointManager } from "./checkpoint.js";
import type { IMemoryStore, L0SessionGroup } from "../core/store/types.js";
import type { Logger } from "../core/types.js";

const logger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

// Note: vitest.config.ts sets restoreMocks: true, which uninstalls spies
// before each test - so the prototype spies must be (re)created in beforeEach,
// not at module scope.
let setL1Spy: ReturnType<typeof vi.spyOn>;
let setL2Spy: ReturnType<typeof vi.spyOn>;

describe("createPipeline runner wiring", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-pipeline-wiring-"));
    setL1Spy = vi.spyOn(MemoryPipelineManager.prototype, "setL1Runner");
    setL2Spy = vi.spyOn(MemoryPipelineManager.prototype, "setL2Runner");
    createOpenAICompatibleRunnerMock.mockClear();
    standaloneCtorMock.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("wires an L2 runner into the scheduler (L2 scene extraction must run in live runtime)", async () => {
    const pipeline = await createPipeline({
      pluginDataDir: tmpDir,
      cfg: parseConfig(undefined),
      openclawConfig: { model: "stub" },
      logger,
    });

    try {
      expect(setL2Spy).toHaveBeenCalledTimes(1);
      const wiredL2 = setL2Spy.mock.calls[0][0];
      expect(typeof wiredL2).toBe("function");
    } finally {
      await pipeline.destroy();
    }
  });

  it("wires an L1 runner into the scheduler", async () => {
    const pipeline = await createPipeline({
      pluginDataDir: tmpDir,
      cfg: parseConfig(undefined),
      openclawConfig: { model: "stub" },
      logger,
    });

    try {
      expect(setL1Spy).toHaveBeenCalledTimes(1);
    } finally {
      await pipeline.destroy();
    }
  });

  it("derives standalone LLM runners from cfg.llm when enabled (live-runtime override)", async () => {
    const cfg = parseConfig({
      llm: {
        enabled: true,
        baseUrl: "http://llm.example.com/v1",
        apiKey: "test-key",
        model: "test-model",
      },
    });

    const pipeline = await createPipeline({
      pluginDataDir: tmpDir,
      cfg,
      openclawConfig: { model: "stub" },
      logger,
    });

    try {
      // v2 L2 only needs text-only JSON calls (title/summary synthesis), so
      // both L1 and L2 derive the plain OpenAI-compatible runner.
      expect(createOpenAICompatibleRunnerMock).toHaveBeenCalledTimes(2);
      expect(createOpenAICompatibleRunnerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "http://llm.example.com/v1",
          apiKey: "test-key",
          model: "test-model",
        }),
      );
      expect(standaloneCtorMock).not.toHaveBeenCalled();
    } finally {
      await pipeline.destroy();
    }
  });

  it("does not construct standalone runners when cfg.llm is disabled", async () => {
    const pipeline = await createPipeline({
      pluginDataDir: tmpDir,
      cfg: parseConfig(undefined),
      openclawConfig: { model: "stub" },
      logger,
    });

    try {
      expect(createOpenAICompatibleRunnerMock).not.toHaveBeenCalled();
      expect(standaloneCtorMock).not.toHaveBeenCalled();
    } finally {
      await pipeline.destroy();
    }
  });

  it("does not construct standalone runners when cfg.llm.enabled but apiKey missing", async () => {
    const cfg = parseConfig({
      llm: { enabled: true, baseUrl: "http://llm.example.com/v1", model: "m" },
    });

    const pipeline = await createPipeline({
      pluginDataDir: tmpDir,
      cfg,
      openclawConfig: { model: "stub" },
      logger,
    });

    try {
      expect(createOpenAICompatibleRunnerMock).not.toHaveBeenCalled();
      expect(standaloneCtorMock).not.toHaveBeenCalled();
    } finally {
      await pipeline.destroy();
    }
  });

  it("prefers explicitly passed runners over cfg.llm-derived runners", async () => {
    const cfg = parseConfig({
      llm: {
        enabled: true,
        baseUrl: "http://llm.example.com/v1",
        apiKey: "test-key",
        model: "test-model",
      },
    });
    const explicitL1 = { run: async () => "explicit" };

    const pipeline = await createPipeline({
      pluginDataDir: tmpDir,
      cfg,
      openclawConfig: { model: "stub" },
      logger,
      l1LlmRunner: explicitL1 as never,
    });

    try {
      // l1 was explicitly provided -> cfg.llm derivation must not duplicate it,
      // but l2 (not provided) still derives from cfg.llm
      expect(createOpenAICompatibleRunnerMock).toHaveBeenCalledTimes(1);
      expect(standaloneCtorMock).not.toHaveBeenCalled();
    } finally {
      await pipeline.destroy();
    }
  });
});

function createPagingL0Store(
  messages: L0SessionGroup["messages"],
  querySpy: ReturnType<typeof vi.fn>,
): IMemoryStore {
  querySpy.mockImplementation((
    _sessionKey: string,
    afterRecordedAtMs?: number,
    limit = 50,
  ): L0SessionGroup[] => {
    const eligible = messages.filter(
      (message) => !afterRecordedAtMs || message.recordedAtMs > afterRecordedAtMs,
    );
    if (eligible.length === 0) return [];

    const boundaryIndex = Math.min(limit, eligible.length) - 1;
    const boundaryRecordedAtMs = eligible[boundaryIndex].recordedAtMs;
    const page = eligible.filter(
      (message) => message.recordedAtMs <= boundaryRecordedAtMs,
    );
    return [{ sessionId: "conversation-1", messages: page }];
  });

  return {
    isDegraded: () => false,
    queryL0GroupedBySessionId: querySpy,
  } as unknown as IMemoryStore;
}

describe("createL1Runner cursor safety", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l1-runner-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects malformed extraction output and leaves the prior cursor unchanged", async () => {
    const sessionKey = "agent:test:parse-failure";
    const checkpoint = new CheckpointManager(tmpDir, logger);
    await checkpoint.markL1ExtractionComplete(sessionKey, 0, 1_000);

    const querySpy = vi.fn();
    const vectorStore = createPagingL0Store([
      {
        id: "msg-1",
        role: "user",
        content: "The project requirement is detailed enough to qualify for memory extraction.",
        timestamp: 2_000,
        recordedAtMs: 2_000,
      },
    ], querySpy);
    const llmRunner = { run: vi.fn(async () => "this is not JSON") };
    const runner = createL1Runner({
      pluginDataDir: tmpDir,
      cfg: parseConfig(undefined),
      openclawConfig: { model: "stub" },
      vectorStore,
      embeddingService: undefined,
      logger,
      llmRunner,
    });

    await expect(runner({ sessionKey })).rejects.toThrow(
      "L1 extraction reported failure",
    );

    const state = checkpoint.getRunnerState(await checkpoint.read(), sessionKey);
    expect(state.last_l1_cursor).toBe(1_000);
    expect(querySpy).toHaveBeenCalledTimes(1);
    expect(llmRunner.run).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty scene object", "[{}]"],
    ["null scene", "[null]"],
    ["invalid memory object", JSON.stringify([{
      scene_name: "project scene",
      message_ids: ["msg-1"],
      memories: [{}],
    }])],
    ["unknown memory type", JSON.stringify([{
      scene_name: "project scene",
      message_ids: ["msg-1"],
      memories: [{
        content: "A structurally complete memory with an unsupported type.",
        type: "unknown",
        priority: 80,
        source_message_ids: ["msg-1"],
        metadata: {},
      }],
    }])],
  ])("rejects semantic extraction error: %s", async (_label, output) => {
    const sessionKey = `agent:test:semantic-${_label}`;
    const querySpy = vi.fn();
    const vectorStore = createPagingL0Store([{
      id: "msg-1",
      role: "user",
      content: "This detailed project context should be processed by memory extraction.",
      timestamp: 2_000,
      recordedAtMs: 2_000,
    }], querySpy);
    const runner = createL1Runner({
      pluginDataDir: tmpDir,
      cfg: parseConfig(undefined),
      openclawConfig: { model: "stub" },
      vectorStore,
      embeddingService: undefined,
      logger,
      llmRunner: { run: vi.fn(async () => output) },
    });

    await expect(runner({ sessionKey })).rejects.toThrow(
      "L1 extraction reported failure",
    );
    const checkpoint = new CheckpointManager(tmpDir, logger);
    expect(checkpoint.getRunnerState(await checkpoint.read(), sessionKey).last_l1_cursor).toBe(0);
  });

  it("propagates L1 persistence failure and preserves the cursor", async () => {
    const sessionKey = "agent:test:write-failure";
    const checkpoint = new CheckpointManager(tmpDir, logger);
    await checkpoint.markL1ExtractionComplete(sessionKey, 0, 1_000);
    // Force records directory creation to fail deterministically.
    await fs.writeFile(path.join(tmpDir, "records"), "not-a-directory", "utf-8");

    const querySpy = vi.fn();
    const vectorStore = createPagingL0Store([{
      id: "msg-1",
      role: "user",
      content: "The user has a durable preference that should become a memory.",
      timestamp: 2_000,
      recordedAtMs: 2_000,
    }], querySpy);
    const output = JSON.stringify([{
      scene_name: "remembering a durable preference",
      message_ids: ["msg-1"],
      memories: [{
        content: "The user prefers concise technical answers.",
        type: "persona",
        priority: 80,
        source_message_ids: ["msg-1"],
        metadata: {},
      }],
    }]);
    const runner = createL1Runner({
      pluginDataDir: tmpDir,
      cfg: parseConfig({ extraction: { enableDedup: false } }),
      openclawConfig: { model: "stub" },
      vectorStore,
      embeddingService: undefined,
      logger,
      llmRunner: { run: vi.fn(async () => output) },
    });

    await expect(runner({ sessionKey })).rejects.toThrow();
    expect(checkpoint.getRunnerState(await checkpoint.read(), sessionKey).last_l1_cursor).toBe(1_000);
  });

  it("uses authoritative JSONL when a non-degraded DB also has L0 rows", async () => {
    const sessionKey = "agent:test:jsonl-source";
    const jsonlRecordedAtMs = Date.UTC(2026, 0, 4);
    const conversationsDir = path.join(tmpDir, "conversations");
    await fs.mkdir(conversationsDir, { recursive: true });
    await fs.writeFile(
      path.join(conversationsDir, "2026-01-04.jsonl"),
      JSON.stringify({
        sessionKey,
        sessionId: "jsonl-conversation",
        recordedAt: new Date(jsonlRecordedAtMs).toISOString(),
        id: "jsonl-msg",
        role: "user",
        content: "This authoritative JSONL message must win over the DB mirror.",
        timestamp: jsonlRecordedAtMs,
      }) + "\n",
      "utf-8",
    );

    const dbQuerySpy = vi.fn();
    const vectorStore = createPagingL0Store([{
      id: "db-only-msg",
      role: "user",
      content: "This inconsistent DB-only row must not be selected.",
      timestamp: jsonlRecordedAtMs + 10_000,
      recordedAtMs: jsonlRecordedAtMs + 10_000,
    }], dbQuerySpy);
    const runner = createL1Runner({
      pluginDataDir: tmpDir,
      cfg: parseConfig(undefined),
      openclawConfig: { model: "stub" },
      vectorStore,
      embeddingService: undefined,
      logger,
      llmRunner: { run: vi.fn(async () => "[]") },
    });

    await expect(runner({ sessionKey })).resolves.toEqual({ processedCount: 1 });
    expect(dbQuerySpy).not.toHaveBeenCalled();
    const checkpoint = new CheckpointManager(tmpDir, logger);
    expect(checkpoint.getRunnerState(await checkpoint.read(), sessionKey).last_l1_cursor)
      .toBe(jsonlRecordedAtMs);
  });

  it("does not advance or fall back to DB when authoritative JSONL is malformed", async () => {
    const sessionKey = "agent:test:malformed-jsonl";
    const checkpoint = new CheckpointManager(tmpDir, logger);
    await checkpoint.markL1ExtractionComplete(sessionKey, 0, 1_000);
    const conversationsDir = path.join(tmpDir, "conversations");
    await fs.mkdir(conversationsDir, { recursive: true });
    await fs.writeFile(
      path.join(conversationsDir, "2026-01-05.jsonl"),
      `{\"sessionKey\":\"${sessionKey}\"\n`,
      "utf-8",
    );

    const dbQuerySpy = vi.fn();
    const vectorStore = createPagingL0Store([{
      id: "db-msg",
      role: "user",
      content: "DB fallback must not hide an authoritative JSONL read failure.",
      timestamp: 2_000,
      recordedAtMs: 2_000,
    }], dbQuerySpy);
    const runner = createL1Runner({
      pluginDataDir: tmpDir,
      cfg: parseConfig(undefined),
      openclawConfig: { model: "stub" },
      vectorStore,
      embeddingService: undefined,
      logger,
      llmRunner: { run: vi.fn(async () => "[]") },
    });

    await expect(runner({ sessionKey })).rejects.toThrow("Malformed JSONL line");
    expect(dbQuerySpy).not.toHaveBeenCalled();
    expect(checkpoint.getRunnerState(await checkpoint.read(), sessionKey).last_l1_cursor).toBe(1_000);
  });

  it("drains more than 50 messages in oldest-first pages without extractor truncation", async () => {
    const sessionKey = "agent:test:backlog";
    const baseMs = Date.UTC(2026, 0, 1);
    const messages: L0SessionGroup["messages"] = Array.from(
      { length: 60 },
      (_, index) => ({
        id: `msg-${String(index).padStart(3, "0")}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `This is qualifying backlog message number ${index} with durable project context.`,
        timestamp: baseMs + index,
        recordedAtMs: baseMs + index * 1_000,
      }),
    );
    const querySpy = vi.fn();
    const vectorStore = createPagingL0Store(messages, querySpy);
    // A valid empty array means "successfully extracted no memories" and must
    // advance the cursor, unlike malformed output.
    const llmRunner = { run: vi.fn(async () => "[]") };
    const runner = createL1Runner({
      pluginDataDir: tmpDir,
      cfg: parseConfig(undefined),
      openclawConfig: { model: "stub" },
      vectorStore,
      embeddingService: undefined,
      logger,
      llmRunner,
    });

    await expect(runner({ sessionKey })).resolves.toEqual({ processedCount: 60 });

    const checkpoint = new CheckpointManager(tmpDir, logger);
    const state = checkpoint.getRunnerState(await checkpoint.read(), sessionKey);
    expect(state.last_l1_cursor).toBe(messages[59].recordedAtMs);
    expect(querySpy).toHaveBeenCalledTimes(3); // 50, 10, then empty
    expect(llmRunner.run).toHaveBeenCalledTimes(6); // six 10-message extraction chunks
  });
});

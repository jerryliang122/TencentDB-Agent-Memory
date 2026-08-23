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
import { createPipeline } from "./pipeline-factory.js";
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

import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

const MAX_TIMER_SECONDS = 2_147_483;

describe("parseConfig numeric safety guards", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back for invalid extraction.maxMemoriesPerSession=%s",
    (value) => {
      const cfg = parseConfig({
        extraction: { maxMemoriesPerSession: value },
      });

      expect(cfg.extraction.maxMemoriesPerSession).toBe(20);
    },
  );

  it("preserves a valid extraction memory limit", () => {
    const cfg = parseConfig({ extraction: { maxMemoriesPerSession: 7 } });
    expect(cfg.extraction.maxMemoriesPerSession).toBe(7);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.NEGATIVE_INFINITY])(
    "falls back for invalid recall.maxResults=%s",
    (value) => {
      const cfg = parseConfig({ recall: { maxResults: value } });
      expect(cfg.recall.maxResults).toBe(5);
    },
  );

  it("caps recall.maxResults at the defensive upper bound", () => {
    expect(parseConfig({ recall: { maxResults: 500 } }).recall.maxResults).toBe(500);
    expect(parseConfig({ recall: { maxResults: 501 } }).recall.maxResults).toBe(500);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back for invalid embedding.conflictRecallTopK=%s",
    (value) => {
      const cfg = parseConfig({ embedding: { conflictRecallTopK: value } });
      expect(cfg.embedding.conflictRecallTopK).toBe(5);
    },
  );

  it("disables remote embedding and clears an invalid dimension", () => {
    const cfg = parseConfig({
      embedding: {
        provider: "openai",
        baseUrl: "https://example.test/v1",
        apiKey: "test-key",
        model: "test-model",
        dimensions: 1.5,
      },
    });

    expect(cfg.embedding.enabled).toBe(false);
    expect(cfg.embedding.dimensions).toBe(0);
    expect(cfg.embedding.configError).toMatch(/dimensions.*positive integer/i);
  });

  it("preserves the provider=none zero-dimension sentinel", () => {
    const cfg = parseConfig({
      embedding: { provider: "none", dimensions: 0 },
    });

    expect(cfg.embedding.enabled).toBe(false);
    expect(cfg.embedding.dimensions).toBe(0);
    expect(cfg.embedding.configError).toBeUndefined();
  });

  it("reports a non-integer dimension even when provider is none", () => {
    const cfg = parseConfig({
      embedding: { provider: "none", dimensions: 1.5 },
    });

    expect(cfg.embedding.enabled).toBe(false);
    expect(cfg.embedding.dimensions).toBe(0);
    expect(cfg.embedding.configError).toMatch(/dimensions.*positive integer/i);
  });

  it("preserves a valid remote embedding dimension", () => {
    const cfg = parseConfig({
      embedding: {
        provider: "openai",
        baseUrl: "https://example.test/v1",
        apiKey: "test-key",
        model: "test-model",
        dimensions: 1536,
      },
    });

    expect(cfg.embedding.enabled).toBe(true);
    expect(cfg.embedding.dimensions).toBe(1536);
    expect(cfg.embedding.configError).toBeUndefined();
  });

  it.each([-1, Number.NaN, Number.NEGATIVE_INFINITY])(
    "falls back for invalid scene.sceneCandidateTtlDays=%s",
    (value) => {
      const cfg = parseConfig({ scene: { sceneCandidateTtlDays: value } });
      expect(cfg.scene.sceneCandidateTtlDays).toBe(30);
    },
  );

  it("preserves zero as the candidate TTL cleanup off switch", () => {
    const cfg = parseConfig({ scene: { sceneCandidateTtlDays: 0 } });
    expect(cfg.scene.sceneCandidateTtlDays).toBe(0);
  });

  it("preserves a positive fractional candidate TTL", () => {
    const cfg = parseConfig({ scene: { sceneCandidateTtlDays: 0.5 } });
    expect(cfg.scene.sceneCandidateTtlDays).toBe(0.5);
  });

  it.each([-1, MAX_TIMER_SECONDS + 1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "falls back for invalid pipeline.l1IdleTimeoutSeconds=%s",
    (value) => {
      const cfg = parseConfig({ pipeline: { l1IdleTimeoutSeconds: value } });
      expect(cfg.pipeline.l1IdleTimeoutSeconds).toBe(600);
    },
  );

  it.each([-1, MAX_TIMER_SECONDS + 1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "falls back for invalid pipeline.l2DelayAfterL1Seconds=%s",
    (value) => {
      const cfg = parseConfig({ pipeline: { l2DelayAfterL1Seconds: value } });
      expect(cfg.pipeline.l2DelayAfterL1Seconds).toBe(10);
    },
  );

  it("allows zero-valued pipeline delays", () => {
    const cfg = parseConfig({
      pipeline: {
        l1IdleTimeoutSeconds: 0,
        l2DelayAfterL1Seconds: 0,
      },
    });

    expect(cfg.pipeline.l1IdleTimeoutSeconds).toBe(0);
    expect(cfg.pipeline.l2DelayAfterL1Seconds).toBe(0);
  });

  it("accepts the largest timer-safe one-shot pipeline delays", () => {
    const cfg = parseConfig({
      pipeline: {
        l1IdleTimeoutSeconds: MAX_TIMER_SECONDS,
        l2DelayAfterL1Seconds: MAX_TIMER_SECONDS,
      },
    });

    expect(cfg.pipeline.l1IdleTimeoutSeconds).toBe(MAX_TIMER_SECONDS);
    expect(cfg.pipeline.l2DelayAfterL1Seconds).toBe(MAX_TIMER_SECONDS);
  });

  it.each([-1, MAX_TIMER_SECONDS + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back for invalid pipeline.l2MinIntervalSeconds=%s",
    (value) => {
      const cfg = parseConfig({ pipeline: { l2MinIntervalSeconds: value } });
      expect(cfg.pipeline.l2MinIntervalSeconds).toBe(900);
    },
  );

  it("allows a zero L2 minimum interval", () => {
    const cfg = parseConfig({ pipeline: { l2MinIntervalSeconds: 0 } });
    expect(cfg.pipeline.l2MinIntervalSeconds).toBe(0);
  });

  it.each([0, 0.0001, -1, MAX_TIMER_SECONDS + 1, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back for invalid pipeline.l2MaxIntervalSeconds=%s",
    (value) => {
      const cfg = parseConfig({ pipeline: { l2MaxIntervalSeconds: value } });
      expect(cfg.pipeline.l2MaxIntervalSeconds).toBe(3600);
    },
  );

  it("accepts the largest timer-safe L2 max interval", () => {
    const cfg = parseConfig({
      pipeline: {
        l2MinIntervalSeconds: 0,
        l2MaxIntervalSeconds: MAX_TIMER_SECONDS,
      },
    });
    expect(cfg.pipeline.l2MaxIntervalSeconds).toBe(MAX_TIMER_SECONDS);
  });

  it("raises the L2 max interval to the configured minimum", () => {
    const cfg = parseConfig({
      pipeline: {
        l2MinIntervalSeconds: 7200,
        l2MaxIntervalSeconds: 60,
      },
    });

    expect(cfg.pipeline.l2MinIntervalSeconds).toBe(7200);
    expect(cfg.pipeline.l2MaxIntervalSeconds).toBe(7200);
  });
});

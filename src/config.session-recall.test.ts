import { describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig recall session-mode fields", () => {
  it("defaults: sessionMode=drift, priming 0.62, drift 0.5, ttl 30min, sceneInjection=off", () => {
    const cfg = parseConfig({});
    expect(cfg.recall.sessionMode).toBe("drift");
    expect(cfg.recall.primingScoreThreshold).toBe(0.62);
    expect(cfg.recall.driftThreshold).toBe(0.5);
    expect(cfg.recall.sessionTtlMinutes).toBe(30);
    expect(cfg.recall.sceneInjection).toBe("off");
  });

  it("accepts valid overrides", () => {
    const cfg = parseConfig({
      recall: {
        sessionMode: "every-turn",
        primingScoreThreshold: 0.58,
        driftThreshold: 0.45,
        sessionTtlMinutes: 60,
        sceneInjection: "ambient",
      },
    });
    expect(cfg.recall.sessionMode).toBe("every-turn");
    expect(cfg.recall.primingScoreThreshold).toBe(0.58);
    expect(cfg.recall.driftThreshold).toBe(0.45);
    expect(cfg.recall.sessionTtlMinutes).toBe(60);
    expect(cfg.recall.sceneInjection).toBe("ambient");
  });

  it.each(["bogus", "", "DRIFT", "per-turn"] as const)(
    "falls back to drift for invalid sessionMode=%s",
    (value) => {
      expect(parseConfig({ recall: { sessionMode: value } }).recall.sessionMode).toBe("drift");
    },
  );

  it.each(["all", "relevant", "", "AMBIENT"] as const)(
    "falls back to off for invalid sceneInjection=%s",
    (value) => {
      expect(parseConfig({ recall: { sceneInjection: value } }).recall.sceneInjection).toBe("off");
    },
  );

  it.each([-0.1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "falls back for out-of-range primingScoreThreshold=%s",
    (value) => {
      expect(parseConfig({ recall: { primingScoreThreshold: value } }).recall.primingScoreThreshold).toBe(0.62);
    },
  );

  it.each([-1, 0, 1.5, Number.NaN])(
    "falls back for invalid sessionTtlMinutes=%s",
    (value) => {
      expect(parseConfig({ recall: { sessionTtlMinutes: value } }).recall.sessionTtlMinutes).toBe(30);
    },
  );

  it("caps sessionTtlMinutes at 1440", () => {
    expect(parseConfig({ recall: { sessionTtlMinutes: 2000 } }).recall.sessionTtlMinutes).toBe(1440);
  });
});

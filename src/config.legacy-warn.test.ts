import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseConfig } from "./config.js";

describe("parseConfig legacy tcvdb warnings", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns when storeBackend is set in raw config", () => {
    parseConfig({ storeBackend: "tcvdb" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/storeBackend.*no longer supported/i);
  });

  it("warns when a tcvdb config block is present", () => {
    parseConfig({ tcvdb: { host: "127.0.0.1" } });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/tcvdb.*removed/i);
  });

  it("warns once when both legacy keys are present", () => {
    parseConfig({ storeBackend: "sqlite", tcvdb: {} });
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it("does not warn for configs without legacy keys", () => {
    parseConfig({ capture: { enabled: true }, extraction: { enabled: false } });
    parseConfig(undefined);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("still returns a valid config when legacy keys are ignored", () => {
    const cfg = parseConfig({ storeBackend: "tcvdb", tcvdb: { host: "x" } });
    expect(cfg.capture.enabled).toBe(true);
  });
});

describe("parseConfig legacy persona/scene migration warnings", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("warns with rename instruction when the persona section is present", () => {
    parseConfig({ persona: { sceneTtlDays: 7 } });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/"persona".*"scene"/);
    expect(warnSpy.mock.calls[0][0]).toMatch(/inner field names are unchanged/);
  });

  it("warns listing removed keys found inside the scene section", () => {
    parseConfig({ scene: { triggerEveryN: 50, maxScenes: 6, sceneTtlDays: 30 } });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/triggerEveryN, maxScenes/);
    expect(warnSpy.mock.calls[0][0]).not.toMatch(/sceneTtlDays/);
  });

  it("detects removed keys inside the legacy persona section too", () => {
    parseConfig({ persona: { l3InjectTopK: 5 } });
    // Two warns: section rename + removed keys
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy.mock.calls[1][0]).toMatch(/l3InjectTopK/);
  });

  it("does not warn for a clean scene section", () => {
    parseConfig({ scene: { sceneTtlDays: 30, model: "my/glm-5" } });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

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

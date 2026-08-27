import { describe, expect, it } from "vitest";
import { isNonInteractiveTrigger, SessionFilter } from "./session-filter.js";

describe("SessionFilter", () => {
  it("skips incognito session keys (memory must leave no traces)", () => {
    const filter = new SessionFilter();
    expect(filter.shouldSkip("agent:main:dashboard:incognito-abc123")).toBe(true);
    expect(filter.shouldSkip("agent:main:subagent:incognito-xyz")).toBe(true);
    expect(filter.shouldSkip("agent:main:internal-session-effects:incognito-q")).toBe(true);
  });

  it("does not skip ordinary session keys", () => {
    const filter = new SessionFilter();
    expect(filter.shouldSkip("agent:main:telegram:12345")).toBe(false);
    expect(filter.shouldSkip("agent:main:whatsapp:incognito-notreally")).toBe(false);
  });

  it("skips built-in internal session patterns", () => {
    const filter = new SessionFilter();
    expect(filter.shouldSkip("agent:main:memory-scene-extract-1")).toBe(true);
    expect(filter.shouldSkip("agent:main:subagent:run-42")).toBe(true);
    expect(filter.shouldSkip("temp:slug-generator")).toBe(true);
  });

  it("skips ctx without sessionKey or with internal session ids", () => {
    const filter = new SessionFilter();
    expect(filter.shouldSkipCtx({})).toBe(true);
    expect(filter.shouldSkipCtx({ sessionKey: "agent:main:telegram:1", sessionId: "memory-bg" })).toBe(true);
  });

  it("applies user-configured glob exclude patterns", () => {
    const filter = new SessionFilter(["bench-judge-*"]);
    expect(filter.shouldSkip("agent:bench-judge-01:telegram:9")).toBe(true);
    expect(filter.shouldSkip("agent:main:telegram:12345")).toBe(false);
  });

  it("detects non-interactive triggers", () => {
    expect(isNonInteractiveTrigger("cron")).toBe(true);
    expect(isNonInteractiveTrigger("heartbeat")).toBe(true);
    expect(isNonInteractiveTrigger(undefined, "agent:main:cron:daily")).toBe(true);
    expect(isNonInteractiveTrigger("user")).toBe(false);
  });
});

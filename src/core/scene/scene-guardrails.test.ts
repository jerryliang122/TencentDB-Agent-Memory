import { describe, it, expect } from "vitest";
import {
  enforceSceneLength,
  detectMergeBloat,
  countBatchMarkers,
} from "./scene-guardrails.js";

describe("enforceSceneLength", () => {
  it("returns content unchanged when within limit", () => {
    const raw = "x".repeat(1000);
    const result = enforceSceneLength(raw, 2000);
    expect(result.truncated).toBe(false);
    expect(result.output).toBe(raw);
    expect(result.originalLength).toBe(1000);
  });

  it("truncates at paragraph boundary when over limit", () => {
    const para1 = "x".repeat(1500);
    const para2 = "\n\n" + "y".repeat(1000);
    const raw = para1 + para2;
    const result = enforceSceneLength(raw, 2000);
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(2502);
    expect(result.output.length).toBeLessThan(2000);
    expect(result.output).toContain("[工程截断");
    expect(result.output).not.toContain("yyy");
  });

  it("falls back to hard char cut when no paragraph boundary in window", () => {
    const raw = "x".repeat(3000);
    const result = enforceSceneLength(raw, 2000);
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(2000);
    expect(result.output).toContain("[工程截断");
  });

  it("handles content shorter than marker", () => {
    const result = enforceSceneLength("short", 100);
    expect(result.truncated).toBe(false);
  });
});

describe("countBatchMarkers", () => {
  it("counts zero markers", () => {
    expect(countBatchMarkers("regular content")).toBe(0);
  });

  it("counts multiple markers", () => {
    const content = `text
[本批次 2026-08-01 增量 · m_001]
middle
[本批次 2026-08-02 增量 · m_002]
end`;
    expect(countBatchMarkers(content)).toBe(2);
  });
});

describe("detectMergeBloat", () => {
  it("returns not suspected when growth is modest", () => {
    const old = "x".repeat(1000);
    const next = "y".repeat(1400);
    const result = detectMergeBloat(old, next, 1.5);
    expect(result.suspected).toBe(false);
  });

  it("suspects when growth exceeds limit AND batch markers increased", () => {
    const old = "base content\n[本批次 a 增量]";
    const next = "base content\n[本批次 a 增量]\n[本批次 b 增量]\n[本批次 c 增量]\n" + "z".repeat(2000);
    const result = detectMergeBloat(old, next, 1.5);
    expect(result.suspected).toBe(true);
    expect(result.reason).toContain("batch markers");
  });

  it("does NOT suspect when growth exceeds limit but no batch markers", () => {
    const old = "x".repeat(1000);
    const next = "y".repeat(2000);
    const result = detectMergeBloat(old, next, 1.5);
    expect(result.suspected).toBe(false);
  });

  it("handles empty old content (new file)", () => {
    const result = detectMergeBloat("", "new content", 1.5);
    expect(result.suspected).toBe(false);
  });
});

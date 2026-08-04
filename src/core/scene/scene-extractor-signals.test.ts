import { describe, it, expect } from "vitest";
import { parseProposeCandidateSignals, sanitizeFilename } from "./scene-extractor.js";

describe("sanitizeFilename", () => {
  it("returns 'scene' for empty input", () => {
    expect(sanitizeFilename("")).toBe("scene");
  });

  it("returns 'scene' for whitespace-only input", () => {
    expect(sanitizeFilename("   ")).toBe("scene");
  });

  it("replaces whitespace runs with single hyphen", () => {
    expect(sanitizeFilename("Daily Rhythm")).toBe("Daily-Rhythm");
    expect(sanitizeFilename("Daily   Rhythm")).toBe("Daily-Rhythm");
  });

  it("preserves CJK characters", () => {
    expect(sanitizeFilename("Rust 学习")).toBe("Rust-学习");
  });

  it("strips brackets and punctuation", () => {
    expect(sanitizeFilename("Coffee (Yirgacheffe)")).toBe("Coffee-Yirgacheffe");
    expect(sanitizeFilename("Q1 Milestone?")).toBe("Q1-Milestone");
    expect(sanitizeFilename("a/b\\c")).toBe("abc");
  });

  it("collapses consecutive separators", () => {
    expect(sanitizeFilename("a--b")).toBe("a-b");
    expect(sanitizeFilename("a   b")).toBe("a-b");
  });

  it("trims leading and trailing separators", () => {
    expect(sanitizeFilename("--abc--")).toBe("abc");
    expect(sanitizeFilename("  abc  ")).toBe("abc");
  });

  it("falls back to scene when all chars stripped", () => {
    expect(sanitizeFilename("()[]{}")).toBe("scene");
    expect(sanitizeFilename("???")).toBe("scene");
  });
});

describe("parseProposeCandidateSignals", () => {
  it("parses single PROPOSE_CANDIDATE block", () => {
    const text = `Some preamble

[PROPOSE_CANDIDATE]
topic: Rust 学习
reason: 用户多次询问 Rust ownership 但无现有场景
matched_memory_ids: [m_001, m_002, m_003]
[/PROPOSE_CANDIDATE]

Some trailing text`;
    const signals = parseProposeCandidateSignals(text);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.topic).toBe("Rust 学习");
    expect(signals[0]!.reason).toContain("Rust ownership");
    expect(signals[0]!.matched_memory_ids).toEqual(["m_001", "m_002", "m_003"]);
  });

  it("parses multiple PROPOSE_CANDIDATE blocks", () => {
    const text = `
[PROPOSE_CANDIDATE]
topic: A
reason: r1
matched_memory_ids: [m_1]
[/PROPOSE_CANDIDATE]

[PROPOSE_CANDIDATE]
topic: B
reason: r2
matched_memory_ids: [m_2, m_3]
[/PROPOSE_CANDIDATE]
`;
    const signals = parseProposeCandidateSignals(text);
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => s.topic)).toEqual(["A", "B"]);
  });

  it("parses inline JSON-less matched_memory_ids", () => {
    const text = `[PROPOSE_CANDIDATE]
topic: Test
reason: r
matched_memory_ids: []
[/PROPOSE_CANDIDATE]`;
    const signals = parseProposeCandidateSignals(text);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.matched_memory_ids).toEqual([]);
  });

  it("returns empty array when no signal present", () => {
    expect(parseProposeCandidateSignals("just regular text")).toEqual([]);
  });

  it("tolerates missing optional fields", () => {
    const text = `[PROPOSE_CANDIDATE]
topic: Only Topic
[/PROPOSE_CANDIDATE]`;
    const signals = parseProposeCandidateSignals(text);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.topic).toBe("Only Topic");
    expect(signals[0]!.reason).toBe("");
    expect(signals[0]!.matched_memory_ids).toEqual([]);
  });
});

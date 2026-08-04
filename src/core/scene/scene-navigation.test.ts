import { describe, it, expect } from "vitest";
import { generateActiveScenes } from "./scene-navigation.js";
import type { SceneIndexEntry } from "./scene-index.js";

const baseEntries: SceneIndexEntry[] = [
  {
    filename: "TopicA.md",
    summary: "A".repeat(300),
    heat: 10,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-08-04T10:00:00.000Z",
  },
  {
    filename: "TopicB.md",
    summary: "B summary",
    heat: 50,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-08-03T10:00:00.000Z",
  },
  {
    filename: "TopicC.md",
    summary: "C summary",
    heat: 1,
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-08-02T10:00:00.000Z",
  },
];

describe("generateActiveScenes", () => {
  it("returns top-K sorted by updated desc", () => {
    const out = generateActiveScenes(baseEntries, 2, 150);
    expect(out).toContain("TopicA"); // 2026-08-04
    expect(out).toContain("TopicB"); // 2026-08-03
    expect(out).not.toContain("TopicC"); // 2026-08-02 dropped
  });

  it("truncates summary to summaryChars", () => {
    const out = generateActiveScenes(baseEntries, 1, 50);
    // TopicA summary is 300 'A' chars; should be truncated
    expect(out).not.toContain("A".repeat(60));
    expect(out).toContain("…");
  });

  it("returns empty string for empty input", () => {
    expect(generateActiveScenes([], 5, 150)).toBe("");
  });

  it("includes heat and path reference", () => {
    const out = generateActiveScenes(baseEntries.slice(0, 1), 5, 150);
    expect(out).toContain("热度");
    expect(out).toContain("TopicA");
  });
});

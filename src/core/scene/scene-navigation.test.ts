import { describe, it, expect } from "vitest";
import { generateActiveScenes } from "./scene-navigation.js";
import type { SceneIndexEntry } from "./scene-index.js";

function entry(overrides: Partial<SceneIndexEntry>): SceneIndexEntry {
  return {
    filename: "Topic.md",
    title: "Topic",
    summary: "s",
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-08-04T10:00:00.000Z",
    first_active: "2026-01-01T00:00:00.000Z",
    last_active: "2026-08-04T10:00:00.000Z",
    memory_count: 1,
    ...overrides,
  };
}

const NOW = new Date("2026-08-23T00:00:00Z");

describe("generateActiveScenes (v2: TTL filter, no top-K)", () => {
  const entries: SceneIndexEntry[] = [
    entry({ filename: "TopicA.md", title: "主题A", summary: "A 现状", last_active: "2026-08-22T10:00:00.000Z", memory_count: 7 }),
    entry({ filename: "TopicB.md", title: "主题B", summary: "B 现状", last_active: "2026-07-30T10:00:00.000Z", memory_count: 2 }),
    entry({ filename: "TopicC.md", title: "主题C", summary: "C 现状", last_active: "2026-01-05T10:00:00.000Z", memory_count: 30 }),
  ];

  it("includes every in-TTL entry (no top-K cap), sorted by last_active desc", () => {
    const out = generateActiveScenes(entries, 30, NOW);
    expect(out).toContain("主题A");
    expect(out).toContain("主题B");
    expect(out.indexOf("主题A")).toBeLessThan(out.indexOf("主题B"));
  });

  it("excludes entries past TTL regardless of memory count", () => {
    const out = generateActiveScenes(entries, 30, NOW);
    expect(out).not.toContain("主题C");
  });

  it("renders title, activity range, summary and pointer scale", () => {
    const out = generateActiveScenes([entries[0]!], 30, NOW);
    expect(out).toContain("主题A (2026-01-01 ~ 08-22)");
    expect(out).toContain("A 现状");
    expect(out).toContain("记忆: 7条");
  });

  it("renders full end date when the range crosses a year boundary", () => {
    const out = generateActiveScenes(
      [entry({ title: "跨年", first_active: "2025-12-30T00:00:00.000Z", last_active: "2026-01-03T00:00:00.000Z" })],
      365, // wide TTL so the January entry is not filtered before rendering
      NOW,
    );
    expect(out).toContain("跨年 (2025-12-30 ~ 2026-01-03)");
  });

  it("collapses to a single date when start equals end", () => {
    const out = generateActiveScenes(
      [entry({ title: "同日", first_active: "2026-08-20T00:00:00.000Z", last_active: "2026-08-20T00:00:00.000Z" })],
      30,
      NOW,
    );
    expect(out).toContain("同日 (2026-08-20)");
  });

  it("keeps entries with unparseable timestamps (cannot age them safely)", () => {
    const out = generateActiveScenes([entry({ title: "未知时间", last_active: "" })], 30, NOW);
    expect(out).toContain("未知时间");
  });

  it("returns empty string for empty input", () => {
    expect(generateActiveScenes([], 30, NOW)).toBe("");
  });
});

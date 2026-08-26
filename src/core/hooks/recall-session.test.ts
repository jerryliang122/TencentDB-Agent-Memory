import { describe, expect, it } from "vitest";
import { RecallSessionTracker } from "./recall-session.js";

describe("RecallSessionTracker", () => {
  it("upsertAnchor creates state; hasAnchor reflects existence", () => {
    const t = new RecallSessionTracker();
    expect(t.hasAnchor("s1")).toBe(false);

    t.upsertAnchor("s1", { anchorText: "帮我优化数据库 schema", anchorEmbedding: [1, 0] });
    expect(t.hasAnchor("s1")).toBe(true);
    const state = t.get("s1")!;
    expect(state.anchorText).toBe("帮我优化数据库 schema");
    expect(state.anchorEmbedding).toEqual([1, 0]);
    expect(state.recalledIds.size).toBe(0);
  });

  it("re-upserting the anchor preserves recalledIds (drift keeps dedup)", () => {
    const t = new RecallSessionTracker();
    t.upsertAnchor("s1", { anchorText: "topic-a" });
    t.mergeRecalledIds("s1", ["m_1", "m_2"]);

    t.upsertAnchor("s1", { anchorText: "topic-b", anchorEmbedding: [0, 1] });
    const state = t.get("s1")!;
    expect(state.anchorText).toBe("topic-b");
    expect([...state.recalledIds]).toEqual(["m_1", "m_2"]);
  });

  it("mergeRecalledIds is a no-op when no anchor exists", () => {
    const t = new RecallSessionTracker();
    t.mergeRecalledIds("missing", ["m_1"]);
    expect(t.hasAnchor("missing")).toBe(false);
    expect(t.size).toBe(0);
  });

  it("clearRecalledIds resets dedup but keeps the anchor (compaction safeguard)", () => {
    const t = new RecallSessionTracker();
    t.upsertAnchor("s1", { anchorText: "topic-a" });
    t.mergeRecalledIds("s1", ["m_1"]);
    t.clearRecalledIds("s1");

    const state = t.get("s1")!;
    expect(state.recalledIds.size).toBe(0);
    expect(state.anchorText).toBe("topic-a");
  });

  it("touch refreshes lastTs so TTL measures inactivity", () => {
    const t = new RecallSessionTracker();
    const t0 = 1_000_000;
    t.upsertAnchor("s1", { anchorText: "a" }, t0);
    t.touch("s1", t0 + 5 * 60_000);

    // 10 minutes after the touch (not after creation) — still alive
    t.sweep(4 * 60_000, t0 + 9 * 60_000);
    expect(t.hasAnchor("s1")).toBe(true);

    // Past the TTL measured from the touch
    t.sweep(4 * 60_000, t0 + 10 * 60_000);
    expect(t.hasAnchor("s1")).toBe(false);
  });

  it("sweep drops sessions idle longer than the TTL", () => {
    const t = new RecallSessionTracker();
    const t0 = 1_000_000;
    t.upsertAnchor("fresh", { anchorText: "a" }, t0);
    t.upsertAnchor("stale", { anchorText: "b" }, t0 - 60_000);

    t.sweep(30_000, t0);
    expect(t.hasAnchor("fresh")).toBe(true);
    expect(t.hasAnchor("stale")).toBe(false);
  });

  it("sweep evicts oldest sessions beyond maxSize", () => {
    const t = new RecallSessionTracker();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      t.upsertAnchor(`s${i}`, { anchorText: `t${i}` }, t0 + i);
    }
    t.sweep(60_000, t0 + 100, 3);

    expect(t.size).toBe(3);
    expect(t.hasAnchor("s0")).toBe(false);
    expect(t.hasAnchor("s1")).toBe(false);
    expect(t.hasAnchor("s4")).toBe(true);
  });
});

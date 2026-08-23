import { describe, it, expect } from "vitest";
import {
  routeMemories,
  cosineSimilarity,
  updateAnchor,
  bigramJaccard,
  type RoutableMemory,
  type RouteTarget,
} from "./scene-router.js";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors, 0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for zero vectors (undefined cosine)", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("returns 0 when vector dimensions differ", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 100])).toBe(0);
  });
});

describe("routeMemories", () => {
  const scenes: RouteTarget[] = [
    { filename: "infra.md", title: "基础设施-测试", anchor: [1, 0, 0, 0] },
    { filename: "cargo.md", title: "货运业务-拼箱", anchor: [0, 1, 0, 0] },
  ];

  function mem(id: string, embedding: number[], sceneName = "", content = ""): RoutableMemory {
    return { id, content, sceneName, ts: "2026-08-20T00:00:00.000Z", embedding };
  }

  it("assigns each memory to its most-similar anchor above threshold", () => {
    const { assignments, unmatched } = routeMemories(
      [mem("a", [0.9, 0.1, 0, 0]), mem("b", [0.05, 0.95, 0, 0])],
      scenes,
      0.3,
    );
    expect(assignments.get("infra.md")?.map((m) => m.id)).toEqual(["a"]);
    expect(assignments.get("cargo.md")?.map((m) => m.id)).toEqual(["b"]);
    expect(unmatched).toHaveLength(0);
  });

  it("leaves sub-threshold memories unmatched", () => {
    const { assignments, unmatched } = routeMemories(
      [mem("a", [0.5, 0.5, 0.7, 0])],
      scenes,
      0.3,
    );
    // cosine([0.5,0.5,0.7,0], [1,0,0,0]) ≈ 0.58 → actually above 0.3; use a
    // vector pointing away from both anchors instead.
    expect(assignments.size).toBe(1);
    expect(unmatched).toHaveLength(0);

    const away = routeMemories([mem("x", [0, 0, 1, 0])], scenes, 0.3);
    expect(away.assignments.size).toBe(0);
    expect(away.unmatched.map((m) => m.id)).toEqual(["x"]);
  });

  it("falls back to text similarity when no embedding is available", () => {
    const { assignments } = routeMemories(
      [{ ...mem("t", [] as unknown as number[], "基础设施升级记录", "基础设施升级记录") }],
      scenes,
      0.3,
    );
    expect(assignments.get("infra.md")?.map((m) => m.id)).toEqual(["t"]);
  });

  it("skips scenes without anchors in vector mode", () => {
    const onlyAnchorless: RouteTarget[] = [{ filename: "x.md", title: "任何主题", anchor: null }];
    const { unmatched } = routeMemories([mem("a", [1, 0])], onlyAnchorless, 0.3);
    expect(unmatched).toHaveLength(1);
  });

  it("does not route by a matching vector prefix when dimensions differ", () => {
    const mismatched: RouteTarget[] = [
      { filename: "legacy.md", title: "unrelated legacy topic", anchor: [1, 0] },
    ];
    const { assignments, unmatched } = routeMemories(
      [mem("new-model", [1, 0, 0], "fresh scene", "fresh content")],
      mismatched,
      0.3,
    );
    expect(assignments.size).toBe(0);
    expect(unmatched.map((item) => item.id)).toEqual(["new-model"]);
  });
});

describe("updateAnchor", () => {
  it("computes running mean incrementally", () => {
    const first = updateAnchor(null, 0, [[2, 0], [4, 0]]);
    expect(first.anchor).toEqual([3, 0]);
    expect(first.count).toBe(2);

    const second = updateAnchor(first.anchor, first.count, [[8, 0], [10, 0]]);
    // mean of [2,4,8,10] = 6
    expect(second.anchor).toEqual([6, 0]);
    expect(second.count).toBe(4);
  });

  it("ignores empty vectors", () => {
    const res = updateAnchor([1, 1], 1, []);
    expect(res.anchor).toEqual([1, 1]);
    expect(res.count).toBe(1);
  });

  it("ignores vectors whose dimensions do not match the anchor", () => {
    const res = updateAnchor([2, 0], 2, [[1, 0, 0]]);
    expect(res.anchor).toEqual([2, 0]);
    expect(res.count).toBe(2);
  });
});

describe("bigramJaccard", () => {
  it("scores CJK overlaps above threshold and unrelated text near zero", () => {
    expect(bigramJaccard("基础设施升级治理", "基础设施配置管理")).toBeGreaterThan(0.2);
    expect(bigramJaccard("基础设施", "cooking recipe")).toBeLessThan(0.05);
  });
});

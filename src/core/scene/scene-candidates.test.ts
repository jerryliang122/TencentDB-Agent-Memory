import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SceneCandidatePool } from "./scene-candidates.js";

describe("SceneCandidatePool (v2: router-driven)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-candidates-"));
    await fs.mkdir(path.join(tmpDir, ".metadata"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("folds anchor-similar memories into one candidate, distinct into another", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    const axisA = [1, 0, 0, 0];
    const axisB = [0, 1, 0, 0];

    pool.addMemory({ id: "m_1", ts: "2026-08-01", head: "A1", sessionKey: "s1" , embedding: axisA  }, 0.3);
    pool.addMemory({ id: "m_2", ts: "2026-08-02", head: "A2", sessionKey: "s1" , embedding: axisA  }, 0.3);
    pool.addMemory({ id: "m_3", ts: "2026-08-03", head: "B1", sessionKey: "s2" , embedding: axisB  }, 0.3);

    const list = pool.list();
    expect(list).toHaveLength(2);
    const a = list.find((c) => c.memories.some((m) => m.id === "m_1"))!;
    expect(a.memories).toHaveLength(2);
    // Anchor = centroid of member vectors
    expect(a.anchor).toEqual([1, 0, 0, 0]);
  });

  it("promotes by memory count threshold", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);

    // 5 memories in one session → memory threshold (5)
    for (let i = 0; i < 5; i++) {
      pool.addMemory(
        { id: `many_${i}`, ts: "2026-08-01", head: `h${i}`, sessionKey: "s-z", embedding: [1, 0, 0, 0] },
        0.3,
      );
    }
    // 2 unrelated singletons stay below every threshold
    pool.addMemory({ id: "solo_1", ts: "2026-08-01", head: "x", sessionKey: "s-a" , embedding: [0, 1, 0, 0]  }, 0.3);
    pool.addMemory({ id: "solo_2", ts: "2026-08-01", head: "y", sessionKey: "s-b" , embedding: [0, 0, 1, 0]  }, 0.3);

    const promotable = pool.findPromotable(5, 3);
    expect(promotable).toHaveLength(1);
    expect(promotable[0]!.memories).toHaveLength(5);
  });

  it("dedupes memory ids within a candidate", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    pool.addMemory({ id: "m_1", ts: "2026-08-01", head: "h", sessionKey: "s" , embedding: [1, 0]  }, 0.3);
    pool.addMemory({ id: "m_1", ts: "2026-08-01", head: "h", sessionKey: "s" , embedding: [1, 0]  }, 0.3);
    expect(pool.list()[0]!.memories).toHaveLength(1);
  });

  it("does not let a retried memory change its candidate or anchor", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    pool.addMemory(
      { id: "m_1", ts: "2026-08-01", head: "original", sessionKey: "s1", embedding: [1, 0] },
      0.3,
      new Date("2026-08-01T00:00:00Z"),
    );
    pool.addMemory(
      { id: "m_1", ts: "2026-08-02", head: "retry", sessionKey: "s2", embedding: [0.8, 0.6] },
      0.3,
      new Date("2026-08-02T00:00:00Z"),
    );

    const candidate = pool.list()[0]!;
    expect(pool.list()).toHaveLength(1);
    expect(candidate.memories).toHaveLength(1);
    expect(candidate.anchor).toEqual([1, 0]);
    expect(candidate.session_keys).toEqual(["s1"]);
    expect(candidate.last_seen_at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("selects the highest-similarity candidate instead of the first match", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    pool.addMemory(
      { id: "m_a", ts: "2026-08-01", head: "aaaa", sessionKey: "s1", embedding: [0.8, 0.6] },
      0.95,
    );
    pool.addMemory(
      { id: "m_b", ts: "2026-08-01", head: "zzzz", sessionKey: "s2", embedding: [1, 0] },
      0.95,
    );
    pool.addMemory(
      { id: "m_best", ts: "2026-08-02", head: "new topic", sessionKey: "s3", embedding: [0.99, 0.1] },
      0.5,
    );

    const containingBest = pool.list().find((candidate) =>
      candidate.memories.some((memory) => memory.id === "m_best"),
    );
    expect(containingBest?.memories.map((memory) => memory.id)).toEqual(["m_b", "m_best"]);
  });

  it("keeps different embedding dimensions in separate candidates", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    pool.addMemory(
      { id: "old", ts: "2026-08-01", head: "alpha topic", sessionKey: "s1", embedding: [1, 0] },
      0.3,
    );
    pool.addMemory(
      { id: "new", ts: "2026-08-02", head: "zulu subject", sessionKey: "s2", embedding: [1, 0, 0] },
      0.3,
    );
    expect(pool.list()).toHaveLength(2);
  });

  it("does not use scene-name fallback to merge orthogonal anchored candidates", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    pool.addMemory(
      {
        id: "axis_a",
        ts: "2026-08-01",
        head: "shared topic first",
        sceneName: "shared scene",
        sessionKey: "s1",
        embedding: [1, 0],
      },
      0.3,
    );
    pool.addMemory(
      {
        id: "axis_b",
        ts: "2026-08-02",
        head: "shared topic second",
        sceneName: "shared scene",
        sessionKey: "s2",
        embedding: [0, 1],
      },
      0.3,
    );
    expect(pool.list()).toHaveLength(2);
  });

  it("weights the centroid by embedded memories only", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    pool.addMemory(
      { id: "text_1", ts: "2026-08-01", head: "shared text one", sceneName: "shared", sessionKey: "s1" },
      0.3,
    );
    pool.addMemory(
      { id: "text_2", ts: "2026-08-02", head: "shared text two", sceneName: "shared", sessionKey: "s2" },
      0.3,
    );
    pool.addMemory(
      {
        id: "vec_1",
        ts: "2026-08-03",
        head: "shared vector one",
        sceneName: "shared",
        sessionKey: "s3",
        embedding: [1, 0],
      },
      0,
    );
    pool.addMemory(
      {
        id: "vec_2",
        ts: "2026-08-04",
        head: "shared vector two",
        sceneName: "shared",
        sessionKey: "s4",
        embedding: [0, 1],
      },
      0,
    );

    expect(pool.list()).toHaveLength(1);
    expect(pool.list()[0]!.anchor).toEqual([0.5, 0.5]);
    expect(pool.list()[0]!.anchor_count).toBe(2);
  });

  it("infers anchor_count when loading a legacy candidate file", async () => {
    await fs.writeFile(
      path.join(tmpDir, ".metadata", "scene_candidates.json"),
      JSON.stringify([
        {
          id: "legacy",
          anchor: [1, 0],
          memories: [
            { id: "m1", ts: "2026-08-01", head: "one", sessionKey: "s1" },
            { id: "m2", ts: "2026-08-02", head: "two", sessionKey: "s2" },
          ],
          session_keys: ["s1", "s2"],
          first_seen_at: "2026-08-01T00:00:00.000Z",
          last_seen_at: "2026-08-02T00:00:00.000Z",
        },
      ]),
      "utf-8",
    );

    const pool = await SceneCandidatePool.load(tmpDir);
    expect(pool.list()[0]!.anchor_count).toBe(2);
  });

  it("groups similar memories without embeddings and reaches promotion threshold", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    for (let i = 0; i < 5; i++) {
      pool.addMemory(
        {
          id: `degraded_${i}`,
          ts: `2026-08-0${i + 1}`,
          head: `database incident detail ${i}`,
          sceneName: "database incident response",
          sessionKey: `s${i % 2}`,
        },
        0.55,
      );
    }

    expect(pool.list()).toHaveLength(1);
    expect(pool.findPromotable(5, 3)).toHaveLength(1);
  });

  it("uses content-head similarity when scene names and embeddings are absent", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    pool.addMemory(
      { id: "text_1", ts: "2026-08-01", head: "postgres backup recovery plan", sessionKey: "s1" },
      0.55,
    );
    pool.addMemory(
      { id: "text_2", ts: "2026-08-02", head: "postgres backup recovery drill", sessionKey: "s2" },
      0.55,
    );
    expect(pool.list()).toHaveLength(1);
    expect(pool.list()[0]!.memories.map((memory) => memory.id)).toEqual(["text_1", "text_2"]);
  });

  it("persists across load/save and prunes expired candidates", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    // Explicit clock: last_seen 2026-08-01 is >30d before the prune date below
    pool.addMemory(
      { id: "m_1", ts: "2026-08-01", head: "h", sessionKey: "s" },
      0.3,
      new Date("2026-08-01T00:00:00Z"),
    );
    await pool.save();

    const reloaded = await SceneCandidatePool.load(tmpDir);
    expect(reloaded.list()).toHaveLength(1);

    const expired = reloaded.pruneExpired(30, new Date("2026-09-15T00:00:00Z"));
    expect(expired).toHaveLength(1);
    expect(reloaded.list()).toHaveLength(0);
  });

  it("sampleHeads returns up to 8 memories for the LLM prompt", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    for (let i = 0; i < 12; i++) {
      pool.addMemory(
        { id: `m_${i}`, ts: "2026-08-01", head: `head-${i}`, sessionKey: "s", embedding: [1, 0, 0, 0] },
        0.3,
      );
    }
    const candidate = pool.list()[0]!;
    expect(candidate.memories).toHaveLength(12);
    expect(pool.sampleHeads(candidate)).toHaveLength(8);
    expect(pool.sampleHeads(candidate)[0]!.head).toBe("head-0");
  });
});

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

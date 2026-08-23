import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SceneCandidatePool } from "./scene-candidates.js";
import { SceneConsolidator } from "./scene-consolidator.js";

describe("SceneConsolidator candidate TTL", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-consolidator-ttl-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not prune candidate evidence when candidateTtlDays is zero", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    pool.addMemory(
      {
        id: "m_old",
        ts: "2020-01-01T00:00:00.000Z",
        head: "old candidate evidence",
        sessionKey: "session-1",
      },
      0.55,
      new Date("2020-01-01T00:00:00.000Z"),
    );
    await pool.save();

    const consolidator = new SceneConsolidator({
      dataDir: tmpDir,
      candidateTtlDays: 0,
      promoteThresholdMemories: 100,
      promoteThresholdSessions: 100,
    });
    await consolidator.consolidate([
      {
        id: "m_old",
        content: "old candidate evidence",
        createdAt: "2020-01-01T00:00:00.000Z",
        sessionKey: "session-1",
      },
    ]);

    const reloaded = await SceneCandidatePool.load(tmpDir);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]!.memories.map((memory) => memory.id)).toEqual(["m_old"]);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SceneCandidatePool } from "./scene-candidates.js";

describe("SceneCandidatePool", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-cand-"));
    await fs.mkdir(path.join(tmpDir, ".metadata"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("adds observation and persists to JSON", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    pool.addObservation("Python-Backend", "m_001", "session-a", "first proposal");
    pool.addObservation("Python-Backend", "m_002", "session-b", "second proposal");
    await pool.save();

    const raw = await fs.readFile(
      path.join(tmpDir, ".metadata", "scene_candidates.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].topic).toBe("Python-Backend");
    expect(parsed[0].matched_memory_ids).toEqual(["m_001", "m_002"]);
    expect(parsed[0].session_keys).toEqual(["session-a", "session-b"]);
    expect(parsed[0].recent_proposals).toHaveLength(2);
  });

  it("dedupes matched_memory_ids and session_keys", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    pool.addObservation("Topic", "m_001", "session-a", "p1");
    pool.addObservation("Topic", "m_001", "session-a", "p2");
    const list = pool.list();
    expect(list[0]!.matched_memory_ids).toEqual(["m_001"]);
    expect(list[0]!.session_keys).toEqual(["session-a"]);
  });

  it("keeps only last 3 proposals", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    for (let i = 0; i < 5; i++) {
      pool.addObservation("Topic", `m_${i}`, "s", `p${i}`);
    }
    expect(pool.list()[0]!.recent_proposals).toHaveLength(3);
    expect(pool.list()[0]!.recent_proposals).toEqual(["p2", "p3", "p4"]);
  });

  it("findPromotable returns candidates meeting memory threshold", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    pool.addObservation("TopicA", "m1", "s1", "p");
    pool.addObservation("TopicA", "m2", "s1", "p");
    pool.addObservation("TopicA", "m3", "s1", "p");
    pool.addObservation("TopicA", "m4", "s1", "p");
    pool.addObservation("TopicA", "m5", "s1", "p");

    const promotable = pool.findPromotable(5, 3);
    expect(promotable.map((c) => c.topic)).toEqual(["TopicA"]);
  });

  it("findPromotable returns candidates meeting session threshold", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    pool.addObservation("TopicB", "m1", "s1", "p");
    pool.addObservation("TopicB", "m2", "s2", "p");
    pool.addObservation("TopicB", "m3", "s3", "p");

    const promotable = pool.findPromotable(5, 3);
    expect(promotable.map((c) => c.topic)).toEqual(["TopicB"]);
  });

  it("removes candidate by topic", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    pool.addObservation("TopicC", "m1", "s1", "p");
    pool.remove("TopicC");
    expect(pool.list()).toHaveLength(0);
  });

  it("prunes expired candidates", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    pool.addObservation("Old", "m1", "s1", "p");
    // Simulate old last_seen_at by direct manipulation
    const list = pool.list();
    list[0]!.last_seen_at = "2020-01-01T00:00:00.000Z";

    const pruned = pool.pruneExpired(30, new Date("2026-08-04T00:00:00.000Z"));
    expect(pruned).toEqual(["Old"]);
    expect(pool.list()).toHaveLength(0);
  });

  it("returns empty array when JSON file missing", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);
    expect(pool.list()).toEqual([]);
  });

  it("recovers gracefully from corrupted JSON", async () => {
    await fs.writeFile(
      path.join(tmpDir, ".metadata", "scene_candidates.json"),
      "{not valid json",
    );
    const pool = await SceneCandidatePool.load(tmpDir);
    expect(pool.list()).toEqual([]);
  });
});

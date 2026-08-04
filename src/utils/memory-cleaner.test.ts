import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalMemoryCleaner } from "./memory-cleaner.js";

describe("LocalMemoryCleaner - candidate pool cleanup", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-cleaner-cand-"));
    await fs.mkdir(path.join(tmpDir, ".metadata"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("prunes expired candidates when sceneCandidateTtlDays > 0", async () => {
    // Seed candidate pool with one expired and one fresh candidate.
    const candidates = [
      {
        topic: "OldTopic",
        matched_memory_ids: ["m_1"],
        session_keys: ["s1"],
        first_seen_at: "2020-01-01T00:00:00.000Z",
        last_seen_at: "2020-01-01T00:00:00.000Z",
        recent_proposals: ["p1"],
      },
      {
        topic: "FreshTopic",
        matched_memory_ids: ["m_2"],
        session_keys: ["s1"],
        first_seen_at: "2026-08-01T00:00:00.000Z",
        last_seen_at: "2026-08-03T00:00:00.000Z",
        recent_proposals: ["p2"],
      },
    ];
    await fs.writeFile(
      path.join(tmpDir, ".metadata", "scene_candidates.json"),
      JSON.stringify(candidates, null, 2),
      "utf-8",
    );

    const cleaner = new LocalMemoryCleaner({
      baseDir: tmpDir,
      retentionDays: 7,
      cleanTime: "03:00",
      sceneTtlDays: 0, // skip scene blocks cleanup
      sceneCandidateTtlDays: 30,
    });

    // Use a fixed "now" well after the FreshTopic's last_seen_at so the
    // OldTopic (last seen 2020) is expired but FreshTopic (last seen 2026-08-03)
    // is still within the 30-day TTL.
    await cleaner.runOnce(Date.parse("2026-08-04T03:00:00.000Z"));

    const raw = await fs.readFile(
      path.join(tmpDir, ".metadata", "scene_candidates.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].topic).toBe("FreshTopic");
  });

  it("skips candidate cleanup when sceneCandidateTtlDays = 0", async () => {
    const candidates = [
      {
        topic: "OldTopic",
        matched_memory_ids: ["m_1"],
        session_keys: ["s1"],
        first_seen_at: "2020-01-01T00:00:00.000Z",
        last_seen_at: "2020-01-01T00:00:00.000Z",
        recent_proposals: ["p1"],
      },
    ];
    await fs.writeFile(
      path.join(tmpDir, ".metadata", "scene_candidates.json"),
      JSON.stringify(candidates, null, 2),
      "utf-8",
    );

    const cleaner = new LocalMemoryCleaner({
      baseDir: tmpDir,
      retentionDays: 7,
      cleanTime: "03:00",
      sceneTtlDays: 0,
      sceneCandidateTtlDays: 0, // disabled
    });

    await cleaner.runOnce(Date.parse("2026-08-04T03:00:00.000Z"));

    const raw = await fs.readFile(
      path.join(tmpDir, ".metadata", "scene_candidates.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1); // OldTopic still present
  });

  it("does not rewrite pool file when no candidates are pruned", async () => {
    const candidates = [
      {
        topic: "FreshTopic",
        matched_memory_ids: ["m_1"],
        session_keys: ["s1"],
        first_seen_at: "2026-08-01T00:00:00.000Z",
        last_seen_at: "2026-08-03T00:00:00.000Z",
        recent_proposals: ["p1"],
      },
    ];
    const poolPath = path.join(tmpDir, ".metadata", "scene_candidates.json");
    await fs.writeFile(poolPath, JSON.stringify(candidates, null, 2), "utf-8");
    const mtimeBefore = (await fs.stat(poolPath)).mtimeMs;

    const cleaner = new LocalMemoryCleaner({
      baseDir: tmpDir,
      retentionDays: 7,
      cleanTime: "03:00",
      sceneTtlDays: 0,
      sceneCandidateTtlDays: 30,
    });

    await cleaner.runOnce(Date.parse("2026-08-04T03:00:00.000Z"));

    const mtimeAfter = (await fs.stat(poolPath)).mtimeMs;
    // File should not have been rewritten (no pruning happened).
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it("handles missing pool file gracefully (non-fatal)", async () => {
    const cleaner = new LocalMemoryCleaner({
      baseDir: tmpDir,
      retentionDays: 7,
      cleanTime: "03:00",
      sceneTtlDays: 0,
      sceneCandidateTtlDays: 30,
    });

    // Should not throw - missing file is treated as empty pool.
    await cleaner.runOnce(Date.parse("2026-08-04T03:00:00.000Z"));

    // Pool file should not have been created (nothing to save).
    await expect(fs.stat(path.join(tmpDir, ".metadata", "scene_candidates.json"))).rejects.toThrow();
  });
});

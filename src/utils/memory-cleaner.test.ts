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

describe("LocalMemoryCleaner - scene blocks TTL cleanup", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-cleaner-scene-"));
    await fs.mkdir(path.join(tmpDir, "scene_blocks"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("preserves scene files with unparseable META.updated timestamp", async () => {
    // Scene with valid updated (old, past TTL)
    await fs.writeFile(
      path.join(tmpDir, "scene_blocks", "OldScene.md"),
      `-----META-START-----
created: 2020-01-01T00:00:00.000Z
updated: 2020-01-01T00:00:00.000Z
summary: old scene
heat: 0
last_full_rewrite_at: 2020-01-01T00:00:00.000Z
-----META-END-----

# Old Scene
content`,
      "utf-8",
    );

    // Scene with unparseable updated (empty string)
    await fs.writeFile(
      path.join(tmpDir, "scene_blocks", "NoUpdated.md"),
      `-----META-START-----
created: 2026-08-01T00:00:00.000Z
updated:
summary: no updated timestamp
heat: 5
last_full_rewrite_at:
-----META-END-----

# No Updated
content`,
      "utf-8",
    );

    // Scene with recent updated (within TTL)
    await fs.writeFile(
      path.join(tmpDir, "scene_blocks", "RecentScene.md"),
      `-----META-START-----
created: 2026-08-01T00:00:00.000Z
updated: 2026-08-03T00:00:00.000Z
summary: recent scene
heat: 10
last_full_rewrite_at: 2026-08-03T00:00:00.000Z
-----META-END-----

# Recent Scene
content`,
      "utf-8",
    );

    // Scene with high heat (within TTL) — ensures OldScene is outside top-3
    await fs.writeFile(
      path.join(tmpDir, "scene_blocks", "HighHeatScene.md"),
      `-----META-START-----
created: 2026-08-01T00:00:00.000Z
updated: 2026-08-03T00:00:00.000Z
summary: high heat scene
heat: 20
last_full_rewrite_at: 2026-08-03T00:00:00.000Z
-----META-END-----

# High Heat Scene
content`,
      "utf-8",
    );

    const cleaner = new LocalMemoryCleaner({
      baseDir: tmpDir,
      retentionDays: 7,
      cleanTime: "03:00",
      sceneTtlDays: 7, // 7-day TTL
      sceneCandidateTtlDays: 0,
    });

    await cleaner.runOnce(Date.parse("2026-08-04T03:00:00.000Z"));

    // OldScene: past TTL, heat=1 (not top-3) → should be deleted
    await expect(fs.stat(path.join(tmpDir, "scene_blocks", "OldScene.md"))).rejects.toThrow();

    // NoUpdated: unparseable timestamp → should be preserved (not deleted)
    await expect(fs.stat(path.join(tmpDir, "scene_blocks", "NoUpdated.md"))).resolves.toBeDefined();

    // RecentScene: within TTL, heat=10 → should be preserved
    await expect(fs.stat(path.join(tmpDir, "scene_blocks", "RecentScene.md"))).resolves.toBeDefined();
  });
});

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
    // Seed candidate pool (v2 router-driven format) with one expired and one fresh candidate.
    const candidates = [
      {
        id: "cand_old",
        anchor: null,
        memories: [{ id: "m_1", ts: "2020-01-01", head: "h", sessionKey: "s1" }],
        session_keys: ["s1"],
        first_seen_at: "2020-01-01T00:00:00.000Z",
        last_seen_at: "2020-01-01T00:00:00.000Z",
      },
      {
        id: "cand_fresh",
        anchor: null,
        memories: [{ id: "m_2", ts: "2026-08-01", head: "h", sessionKey: "s1" }],
        session_keys: ["s1"],
        first_seen_at: "2026-08-01T00:00:00.000Z",
        last_seen_at: "2026-08-03T00:00:00.000Z",
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

    // Fixed "now" well after FreshTopic's last_seen_at so the old candidate
    // (last seen 2020) is expired but the fresh one (2026-08-03) is within TTL.
    await cleaner.runOnce(Date.parse("2026-08-04T03:00:00.000Z"));

    const raw = await fs.readFile(
      path.join(tmpDir, ".metadata", "scene_candidates.json"),
      "utf-8",
    );
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe("cand_fresh");
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

  it("preserves v2 scene files with unparseable last_active, archives expired ones", async () => {
    // Scene with old last_active (past TTL) → archived
    await fs.writeFile(
      path.join(tmpDir, "scene_blocks", "OldScene.md"),
      `-----META-START-----
title: OldScene
created: 2020-01-01T00:00:00.000Z
updated: 2020-01-01T00:00:00.000Z
first_active: 2020-01-01T00:00:00.000Z
last_active: 2020-01-01T00:00:00.000Z
summary: old scene
memory_count: 1
-----META-END-----

## Memory Pointers
- m_1 | 2020-01-01 | old`,
      "utf-8",
    );

    // Scene with unparseable last_active → preserved (can't age it safely)
    await fs.writeFile(
      path.join(tmpDir, "scene_blocks", "NoUpdated.md"),
      `-----META-START-----
title: NoUpdated
created: 2026-08-01T00:00:00.000Z
updated: 2026-08-01T00:00:00.000Z
first_active: 2026-08-01T00:00:00.000Z
last_active: not-a-date
summary: no parseable activity time
memory_count: 1
-----META-END-----

## Memory Pointers
- m_2 | 2026-08-01 | x`,
      "utf-8",
    );

    // Scene with recent last_active (within TTL) → preserved
    await fs.writeFile(
      path.join(tmpDir, "scene_blocks", "RecentScene.md"),
      `-----META-START-----
title: RecentScene
created: 2026-08-01T00:00:00.000Z
updated: 2026-08-03T00:00:00.000Z
first_active: 2026-08-01T00:00:00.000Z
last_active: 2026-08-03T00:00:00.000Z
summary: recent scene
memory_count: 2
-----META-END-----

## Memory Pointers
- m_3 | 2026-08-03 | recent`,
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

    // OldScene: past TTL → archived away
    await expect(fs.stat(path.join(tmpDir, "scene_blocks", "OldScene.md"))).rejects.toThrow();
    await expect(
      fs.stat(path.join(tmpDir, ".backup", "scene_blocks_expired", "OldScene.md")),
    ).resolves.toBeDefined();

    // NoUpdated: unparseable timestamp → preserved (not archived)
    await expect(fs.stat(path.join(tmpDir, "scene_blocks", "NoUpdated.md"))).resolves.toBeDefined();

    // RecentScene: within TTL → preserved
    await expect(fs.stat(path.join(tmpDir, "scene_blocks", "RecentScene.md"))).resolves.toBeDefined();
  });
});

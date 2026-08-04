import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SceneCandidatePool } from "./scene/scene-candidates.js";
import { enforceSceneLength } from "./scene/scene-guardrails.js";
import { generateActiveScenes } from "./scene/scene-navigation.js";
import { parseProposeCandidateSignals } from "./scene/scene-extractor.js";
import type { SceneIndexEntry } from "./scene/scene-index.js";

describe("L2/L3 redesign integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-redesign-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("end-to-end: candidates → promotion → length enforcement → active scenes", async () => {
    const llmOutput = `[PROPOSE_CANDIDATE]
topic: NewTopic
reason: New project discussions
matched_memory_ids: [m_1, m_2, m_3, m_4, m_5]
[/PROPOSE_CANDIDATE]`;

    const signals = parseProposeCandidateSignals(llmOutput);
    expect(signals).toHaveLength(1);

    const pool = await SceneCandidatePool.load(tmpDir);
    for (const memId of signals[0]!.matched_memory_ids) {
      pool.addObservation(signals[0]!.topic, memId, "session-1", signals[0]!.reason);
    }

    const promotable = pool.findPromotable(5, 3);
    expect(promotable.map((c) => c.topic)).toEqual(["NewTopic"]);

    const sceneBlocksDir = path.join(tmpDir, "scene_blocks");
    await fs.mkdir(sceneBlocksDir, { recursive: true });
    const longContent = "x".repeat(3000);
    await fs.writeFile(path.join(sceneBlocksDir, "NewTopic.md"), longContent, "utf-8");

    const raw = await fs.readFile(path.join(sceneBlocksDir, "NewTopic.md"), "utf-8");
    const result = enforceSceneLength(raw, 2000);
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(2000);
    await fs.writeFile(path.join(sceneBlocksDir, "NewTopic.md"), result.output, "utf-8");

    const sceneIndex: SceneIndexEntry[] = [
      {
        filename: "NewTopic.md",
        summary: "A".repeat(300),
        heat: 5,
        created: "2026-08-04T00:00:00.000Z",
        updated: "2026-08-04T00:00:00.000Z",
      },
    ];
    const activeText = generateActiveScenes(sceneIndex, 5, 50);
    expect(activeText).toContain("NewTopic");
    expect(activeText).toContain("热度");
    expect(activeText).not.toContain("A".repeat(60));
    expect(activeText).toContain("…");
  });

  it("sessionKey threading: addObservation uses distinct session keys for promotion threshold", async () => {
    const pool = await SceneCandidatePool.load(tmpDir);

    // Same topic observed across 3 different sessions (each with 1 memory)
    pool.addObservation("CrossSessionTopic", "m_1", "session-a", "first");
    pool.addObservation("CrossSessionTopic", "m_2", "session-b", "second");
    pool.addObservation("CrossSessionTopic", "m_3", "session-c", "third");

    // Memory threshold (5) not met, but session threshold (3) is
    const bySessions = pool.findPromotable(10, 3);
    expect(bySessions.map((c) => c.topic)).toEqual(["CrossSessionTopic"]);

    // Same topic in a single session, 5 memories — session threshold not met
    const singleSessionTopic = "SingleSessionTopic";
    for (let i = 0; i < 5; i++) {
      pool.addObservation(singleSessionTopic, `m_${i + 10}`, "session-z", `obs-${i}`);
    }
    const byMemories = pool.findPromotable(5, 10);
    expect(byMemories.map((c) => c.topic)).toEqual(["SingleSessionTopic"]);
  });
});

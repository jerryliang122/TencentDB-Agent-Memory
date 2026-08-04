/**
 * Scene Candidate Pool: tracks LLM-proposed scene topics that haven't yet
 * been promoted to formal scene_blocks/*.md files.
 *
 * Storage: <dataDir>/.metadata/scene_candidates.json (single JSON array,
 * independent from recall_checkpoint.json to avoid polluting checkpoint).
 *
 * Lifecycle:
 *   1. LLM emits [PROPOSE_CANDIDATE] in text output when no existing scene
 *      matches new memories.
 *   2. SceneExtractor parses the signal, calls addObservation().
 *   3. After each extraction, findPromotable() is called — candidates meeting
 *      memory-count OR session-count threshold are returned for promotion.
 *   4. Promoted candidates are removed from the pool and a formal scene file
 *      is created via a dedicated LLM call.
 *   5. pruneExpired() is called by the daily memory-cleaner to drop dead topics.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai][candidates]";

export interface SceneCandidate {
  topic: string;
  matched_memory_ids: string[];
  session_keys: string[];
  first_seen_at: string;
  last_seen_at: string;
  recent_proposals: string[];
}

const MAX_PROPOSALS = 3;
const CANDIDATES_FILENAME = "scene_candidates.json";

export class SceneCandidatePool {
  private candidates: SceneCandidate[] = [];
  private readonly filePath: string;
  private readonly logger?: Logger;

  private constructor(dataDir: string, logger?: Logger) {
    this.filePath = path.join(dataDir, ".metadata", CANDIDATES_FILENAME);
    this.logger = logger;
  }

  static async load(dataDir: string, logger?: Logger): Promise<SceneCandidatePool> {
    const pool = new SceneCandidatePool(dataDir, logger);
    await pool.reload();
    return pool;
  }

  private async reload(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this.logger?.warn?.(`${TAG} candidates JSON is not an array, starting empty`);
        this.candidates = [];
        return;
      }
      this.candidates = parsed.filter(this.isValidCandidate.bind(this));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.candidates = [];
        return;
      }
      // Corrupted JSON — start empty (non-fatal)
      this.logger?.warn?.(
        `${TAG} candidates JSON corrupted, starting empty: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.candidates = [];
    }
  }

  private isValidCandidate(x: unknown): x is SceneCandidate {
    if (!x || typeof x !== "object") return false;
    const o = x as Record<string, unknown>;
    return (
      typeof o.topic === "string" &&
      Array.isArray(o.matched_memory_ids) &&
      Array.isArray(o.session_keys) &&
      typeof o.first_seen_at === "string" &&
      typeof o.last_seen_at === "string" &&
      Array.isArray(o.recent_proposals)
    );
  }

  list(): SceneCandidate[] {
    return [...this.candidates];
  }

  addObservation(
    topic: string,
    memoryId: string,
    sessionKey: string,
    proposal: string,
    now: Date = new Date(),
  ): void {
    const iso = now.toISOString();
    let cand = this.candidates.find((c) => c.topic === topic);
    if (!cand) {
      cand = {
        topic,
        matched_memory_ids: [],
        session_keys: [],
        first_seen_at: iso,
        last_seen_at: iso,
        recent_proposals: [],
      };
      this.candidates.push(cand);
    }
    if (!cand.matched_memory_ids.includes(memoryId)) {
      cand.matched_memory_ids.push(memoryId);
    }
    if (!cand.session_keys.includes(sessionKey)) {
      cand.session_keys.push(sessionKey);
    }
    cand.recent_proposals.push(proposal);
    if (cand.recent_proposals.length > MAX_PROPOSALS) {
      cand.recent_proposals = cand.recent_proposals.slice(-MAX_PROPOSALS);
    }
    cand.last_seen_at = iso;
  }

  findPromotable(thresholdMemories: number, thresholdSessions: number): SceneCandidate[] {
    return this.candidates.filter(
      (c) =>
        c.matched_memory_ids.length >= thresholdMemories ||
        c.session_keys.length >= thresholdSessions,
    );
  }

  remove(topic: string): void {
    this.candidates = this.candidates.filter((c) => c.topic !== topic);
  }

  pruneExpired(ttlDays: number, now: Date = new Date()): string[] {
    const cutoffMs = now.getTime() - ttlDays * 86_400_000;
    const expired: string[] = [];
    const survivors: SceneCandidate[] = [];
    for (const c of this.candidates) {
      const lastMs = Date.parse(c.last_seen_at);
      if (Number.isFinite(lastMs) && lastMs < cutoffMs) {
        expired.push(c.topic);
      } else {
        survivors.push(c);
      }
    }
    this.candidates = survivors;
    return expired;
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp.${randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, JSON.stringify(this.candidates, null, 2), "utf-8");
    await fs.rename(tmp, this.filePath);
  }
}

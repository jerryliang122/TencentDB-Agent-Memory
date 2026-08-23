/**
 * Scene Candidate Pool (v2): engineering-driven topic incubator.
 *
 * v1 fed candidates from LLM [PROPOSE_CANDIDATE] text signals. v2 removes
 * the LLM from this path entirely: the router (scene-router.ts) pushes
 * unmatched memories here, similarity is computed against each candidate's
 * running-centroid anchor, and promotion is a pure counter check.
 *
 * Lifecycle:
 *   1. Router leaves a memory unmatched → pool.addMemory()
 *   2. addMemory folds it into an anchor-similar candidate or creates one
 *   3. findPromotable() returns candidates meeting the memory-count OR
 *      session-count threshold — the consolidator promotes them via one
 *      LLM call (title + summary synthesis)
 *   4. pruneExpired() drops topics with no new evidence within TTL days
 *
 * Storage: <dataDir>/.metadata/scene_candidates.json (atomic rewrite).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { cosineSimilarity } from "./scene-router.js";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai][candidates]";

export interface CandidateMemory {
  id: string;
  ts: string;
  /** Short content head — used for LLM title synthesis and debugging. */
  head: string;
  sessionKey: string;
}

export interface SceneCandidate {
  id: string;
  /** Running centroid of member-memory embeddings; null in degraded mode. */
  anchor: number[] | null;
  memories: CandidateMemory[];
  session_keys: string[];
  first_seen_at: string;
  last_seen_at: string;
}

/** Heads kept per candidate — bounds the JSON file and the LLM prompt. */
const MAX_SAMPLE_HEADS = 8;

export class SceneCandidatePool {
  private candidates: SceneCandidate[] = [];
  private readonly filePath: string;
  private readonly logger?: Logger;

  private constructor(dataDir: string, logger?: Logger) {
    this.filePath = path.join(dataDir, ".metadata", "scene_candidates.json");
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
      this.candidates = parsed.filter(isValidCandidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.candidates = [];
        return;
      }
      this.logger?.warn?.(
        `${TAG} candidates JSON corrupted, starting empty: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.candidates = [];
    }
  }

  list(): SceneCandidate[] {
    return [...this.candidates];
  }

  /**
   * Fold a router-unmatched memory into an anchor-similar candidate, or
   * create a new candidate when nothing is similar enough.
   */
  addMemory(
    mem: CandidateMemory & { embedding?: Float32Array | number[] },
    matchThreshold: number,
    now: Date = new Date(),
  ): void {
    const iso = now.toISOString();
    let target: SceneCandidate | undefined;

    if (mem.embedding && mem.embedding.length > 0) {
      for (const cand of this.candidates) {
        if (!cand.anchor) continue;
        const score = cosineSimilarity(mem.embedding, cand.anchor);
        if (score >= matchThreshold) {
          target = cand;
          break;
        }
      }
    }

    if (!target) {
      target = {
        id: `cand_${Date.now()}_${randomBytes(3).toString("hex")}`,
        anchor: null,
        memories: [],
        session_keys: [],
        first_seen_at: iso,
        last_seen_at: iso,
      };
      this.candidates.push(target);
    }

    if (!target.memories.some((m) => m.id === mem.id)) {
      target.memories.push({ id: mem.id, ts: mem.ts, head: mem.head, sessionKey: mem.sessionKey });
    }
    if (mem.sessionKey && !target.session_keys.includes(mem.sessionKey)) {
      target.session_keys.push(mem.sessionKey);
    }

    // Incremental centroid: fold the new vector into the running mean.
    if (mem.embedding && mem.embedding.length > 0) {
      const n = target.memories.length;
      const dims = mem.embedding.length;
      if (!target.anchor) {
        target.anchor = Array.from(mem.embedding, (v) => v as number);
      } else if (target.anchor.length === dims) {
        target.anchor = target.anchor.map(
          (old, i) => (old * (n - 1) + (mem.embedding as ArrayLike<number>)[i]!) / n,
        );
      }
    }

    target.last_seen_at = iso;
  }

  findPromotable(thresholdMemories: number, thresholdSessions: number): SceneCandidate[] {
    return this.candidates.filter(
      (c) => c.memories.length >= thresholdMemories || c.session_keys.length >= thresholdSessions,
    );
  }

  remove(id: string): void {
    this.candidates = this.candidates.filter((c) => c.id !== id);
  }

  pruneExpired(ttlDays: number, now: Date = new Date()): string[] {
    const cutoffMs = now.getTime() - ttlDays * 86_400_000;
    const expired: string[] = [];
    const survivors: SceneCandidate[] = [];
    for (const c of this.candidates) {
      const lastMs = Date.parse(c.last_seen_at);
      if (Number.isFinite(lastMs) && lastMs < cutoffMs) {
        expired.push(c.id);
      } else {
        survivors.push(c);
      }
    }
    this.candidates = survivors;
    return expired;
  }

  /** Up to MAX_SAMPLE_HEADS memory samples, oldest first — LLM prompt input. */
  sampleHeads(candidate: SceneCandidate): Array<{ head: string; ts: string }> {
    return candidate.memories.slice(0, MAX_SAMPLE_HEADS).map((m) => ({ head: m.head, ts: m.ts }));
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp.${randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, JSON.stringify(this.candidates, null, 2), "utf-8");
    await fs.rename(tmp, this.filePath);
  }
}

function isValidCandidate(x: unknown): x is SceneCandidate {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    Array.isArray(o.memories) &&
    Array.isArray(o.session_keys) &&
    typeof o.first_seen_at === "string" &&
    typeof o.last_seen_at === "string" &&
    (o.anchor === null || Array.isArray(o.anchor))
  );
}

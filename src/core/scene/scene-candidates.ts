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
import {
  TEXT_FALLBACK_THRESHOLD,
  bigramJaccard,
  cosineSimilarity,
} from "./scene-router.js";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai][candidates]";

export interface CandidateMemory {
  id: string;
  ts: string;
  /** Short content head — used for LLM title synthesis and debugging. */
  head: string;
  sessionKey: string;
  /** L1 extraction's scene label — strengthens degraded-mode matching. */
  sceneName?: string;
}

export interface SceneCandidate {
  id: string;
  /** Running centroid of member-memory embeddings; null in degraded mode. */
  anchor: number[] | null;
  /** Number of embeddings represented by the anchor (legacy files may omit it). */
  anchor_count?: number;
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
      this.candidates = parsed.filter(isValidCandidate).map((candidate) => ({
        ...candidate,
        anchor_count: candidateAnchorCount(candidate),
      }));
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
    // A retried memory may carry a different vector or session. It must not
    // move an existing centroid, create a second candidate, or refresh TTL.
    if (this.candidates.some((cand) => cand.memories.some((item) => item.id === mem.id))) {
      return;
    }

    const iso = now.toISOString();
    let target: SceneCandidate | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    const embedding = mem.embedding && mem.embedding.length > 0 ? mem.embedding : undefined;

    if (embedding) {
      for (const cand of this.candidates) {
        if (!cand.anchor) continue;
        if (cand.anchor.length !== embedding.length) continue;
        const score = cosineSimilarity(embedding, cand.anchor);
        if (score >= matchThreshold && score > bestScore) {
          target = cand;
          bestScore = score;
        }
      }
    }

    if (!target) {
      bestScore = Number.NEGATIVE_INFINITY;
      for (const cand of this.candidates) {
        // A real vector may bootstrap an anchor-less degraded candidate, but
        // it must not bypass an established anchor's cosine decision.
        if (embedding && cand.anchor) continue;
        const score = candidateTextSimilarity(mem, cand);
        if (score >= TEXT_FALLBACK_THRESHOLD && score > bestScore) {
          target = cand;
          bestScore = score;
        }
      }
    }

    if (!target) {
      target = {
        id: `cand_${Date.now()}_${randomBytes(3).toString("hex")}`,
        anchor: null,
        anchor_count: 0,
        memories: [],
        session_keys: [],
        first_seen_at: iso,
        last_seen_at: iso,
      };
      this.candidates.push(target);
    }

    target.memories.push({
      id: mem.id,
      ts: mem.ts,
      head: mem.head,
      sessionKey: mem.sessionKey,
      sceneName: mem.sceneName,
    });
    if (mem.sessionKey && !target.session_keys.includes(mem.sessionKey)) {
      target.session_keys.push(mem.sessionKey);
    }

    // Incremental centroid: fold the new vector into the running mean.
    if (embedding) {
      const dims = embedding.length;
      if (!target.anchor) {
        target.anchor = Array.from(embedding, (v) => v as number);
        target.anchor_count = 1;
      } else if (target.anchor.length === dims) {
        const count = candidateAnchorCount(target);
        target.anchor = target.anchor.map(
          (old, i) => (old * count + embedding[i]!) / (count + 1),
        );
        target.anchor_count = count + 1;
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

/** Effective vector count, preserving the weighting used by legacy pool files. */
export function candidateAnchorCount(candidate: SceneCandidate): number {
  if (!candidate.anchor) return 0;
  const stored = candidate.anchor_count;
  if (stored !== undefined && Number.isInteger(stored) && stored > 0) return stored;
  return Math.max(1, candidate.memories.length);
}

function candidateTextSimilarity(mem: CandidateMemory, candidate: SceneCandidate): number {
  let best = 0;
  for (const existing of candidate.memories) {
    if (mem.sceneName && existing.sceneName) {
      best = Math.max(best, bigramJaccard(mem.sceneName, existing.sceneName));
    }
    best = Math.max(best, bigramJaccard(mem.head, existing.head));
    best = Math.max(
      best,
      bigramJaccard(
        `${mem.sceneName ?? ""} ${mem.head}`,
        `${existing.sceneName ?? ""} ${existing.head}`,
      ),
    );
  }
  return best;
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
    (o.anchor === null || Array.isArray(o.anchor)) &&
    (o.anchor_count === undefined ||
      (typeof o.anchor_count === "number" && Number.isInteger(o.anchor_count) && o.anchor_count >= 0))
  );
}

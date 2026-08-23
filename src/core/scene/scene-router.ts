/**
 * Scene Router: deterministic assignment of new L1 memories to existing
 * scenes by embedding cosine similarity against per-scene anchor vectors.
 *
 * This is the heart of the v2 L2 design — the decision "which scene does
 * this memory belong to" is made by vector math, not by an LLM agent.
 *
 * Match order per memory:
 *   1. cosine(memory embedding, scene anchor) — primary signal
 *   2. character-bigram Jaccard(memory scene_name + content head, scene
 *      title) — degraded-mode signal when embeddings are unavailable
 *
 * Memories matching no scene are returned as `unmatched` and flow into the
 * candidate pool (scene-candidates.ts) for threshold-based promotion.
 */

export interface RoutableMemory {
  id: string;
  content: string;
  /** L1 extraction's conversation-level scene label — routing hint only. */
  sceneName?: string;
  /** ISO timestamp of the memory. */
  ts: string;
  sessionKey?: string;
  /** Pre-computed embedding (from vectors.db). Absent in degraded mode. */
  embedding?: Float32Array | number[];
}

export interface RouteTarget {
  filename: string;
  title: string;
  /** Running-mean anchor vector; absent until the scene receives memories. */
  anchor?: number[] | null;
}

export interface RoutingResult {
  /** filename → matched memories (order preserved). */
  assignments: Map<string, RoutableMemory[]>;
  /** Memories that matched no scene — feed the candidate pool. */
  unmatched: RoutableMemory[];
}

/**
 * Default cosine threshold for scene membership (BGE-M3 balanced band).
 * Routing failure is asymmetric: a sub-threshold memory safely flows to the
 * candidate pool, while a wrong-scene assignment pollutes the scene — so the
 * default leans precise rather than loose.
 */
export const DEFAULT_ROUTING_THRESHOLD = 0.55;

/** Bigram-Jaccard threshold for the text fallback (empirical). */
export const TEXT_FALLBACK_THRESHOLD = 0.22;

export function cosineSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function routeMemories(
  memories: RoutableMemory[],
  scenes: RouteTarget[],
  threshold: number = DEFAULT_ROUTING_THRESHOLD,
): RoutingResult {
  const assignments = new Map<string, RoutableMemory[]>();
  const unmatched: RoutableMemory[] = [];

  for (const mem of memories) {
    let best: { filename: string; score: number } | undefined;

    if (mem.embedding) {
      for (const scene of scenes) {
        if (!scene.anchor || scene.anchor.length === 0) continue;
        const score = cosineSimilarity(mem.embedding, scene.anchor);
        if (score >= threshold && (!best || score > best.score)) {
          best = { filename: scene.filename, score };
        }
      }
    }

    if (!best) {
      // Degraded mode / anchor-less scenes: text similarity fallback.
      const text = `${mem.sceneName ?? ""} ${mem.content.slice(0, 120)}`;
      for (const scene of scenes) {
        const score = bigramJaccard(text, scene.title);
        if (score >= TEXT_FALLBACK_THRESHOLD && (!best || score > best.score)) {
          best = { filename: scene.filename, score };
        }
      }
    }

    if (best) {
      const list = assignments.get(best.filename) ?? [];
      list.push(mem);
      assignments.set(best.filename, list);
    } else {
      unmatched.push(mem);
    }
  }

  return { assignments, unmatched };
}

/**
 * Incremental running-mean anchor update:
 * newAnchor = (oldAnchor * oldCount + sum(newVectors)) / (oldCount + newCount)
 */
export function updateAnchor(
  anchor: number[] | null | undefined,
  count: number,
  vectors: Array<Float32Array | number[]>,
): { anchor: number[] | null; count: number } {
  const usable = vectors.filter((v) => v && v.length > 0);
  if (usable.length === 0) return { anchor: anchor ?? null, count };

  const dims = Math.max(anchor?.length ?? 0, ...usable.map((v) => v.length));
  if (dims === 0) return { anchor: anchor ?? null, count };

  const sum = new Array<number>(dims).fill(0);
  if (anchor) {
    for (let i = 0; i < anchor.length; i++) sum[i]! += anchor[i]! * count;
  }
  for (const v of usable) {
    for (let i = 0; i < v.length; i++) sum[i]! += v[i]!;
  }
  const newCount = count + usable.length;
  return { anchor: sum.map((s) => s / newCount), count: newCount };
}

/** Character-bigram Jaccard similarity — CJK-friendly, allocation-light. */
export function bigramJaccard(a: string, b: string): number {
  const setA = bigramSet(a);
  const setB = bigramSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const g of setA) if (setB.has(g)) inter++;
  return inter / (setA.size + setB.size - inter);
}

function bigramSet(s: string): Set<string> {
  const normalized = s.replace(/\s+/g, "").toLowerCase();
  const set = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i++) {
    set.add(normalized.slice(i, i + 2));
  }
  return set;
}

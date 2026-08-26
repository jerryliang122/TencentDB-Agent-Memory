/**
 * Session-anchored recall state for `recall.sessionMode`.
 *
 * A conversation is usually one task. Instead of re-running the full recall
 * pipeline with the latest message every turn (phrasing drift pulls in
 * irrelevant memories), the first qualifying message "primes" the session and
 * becomes its anchor; later turns only check drift against that anchor.
 *
 * State is intentionally in-memory only: a process restart mid-session simply
 * re-primes once on the next message, which is harmless. TTL + size bounds
 * mirror the pending-* caches in index.ts.
 */

/**
 * Bigram-Jaccard drift threshold for deployments without embeddings.
 * Same scale as scene-router's TEXT_FALLBACK_THRESHOLD (empirical): cosine
 * thresholds do not transfer to this scale, so drift in degraded mode uses
 * its own constant instead of `recall.driftThreshold`.
 */
export const DRIFT_TEXT_FALLBACK_THRESHOLD = 0.22;

/** Per-session anchor + already-injected record ids. */
export interface RecallSessionState {
  /** Embedding of the anchoring message (absent in keyword-only deployments). */
  anchorEmbedding?: number[];
  /** Sanitized anchoring message text — bigram fallback when no embedding. */
  anchorText: string;
  /** record_ids already injected this session; drift re-primes inject only new ones. */
  recalledIds: Set<string>;
  lastTs: number;
}

/** Session context handed to performAutoRecall (see `recall.sessionMode`). */
export interface SessionRecallParams {
  mode: "drift" | "first-turn" | "every-turn";
  /** Whether an anchor exists for this session (false on the first qualifying turn). */
  hasAnchor: boolean;
  anchorEmbedding?: number[];
  anchorText?: string;
  /** Cosine below this = topic switch (`recall.driftThreshold`). */
  driftThreshold: number;
  /** record_ids already injected this session — a drift re-prime excludes them. */
  excludeRecordIds?: string[];
  /** Force re-prime, bypassing the drift check (history compaction detected). */
  forceReprime?: boolean;
}

/** Anchor + injected-id bookkeeping returned by performAutoRecall. */
export interface SessionRecallUpdate {
  anchorText: string;
  anchorEmbedding?: number[];
  /** record_ids injected by this prime (empty when the vector gate blocked). */
  newRecordIds: string[];
  decision: "session-first" | "drift-recall";
}

const DEFAULT_MAX_SESSIONS = 10_000;

export class RecallSessionTracker {
  private sessions = new Map<string, RecallSessionState>();

  get(sessionKey: string): RecallSessionState | undefined {
    return this.sessions.get(sessionKey);
  }

  hasAnchor(sessionKey: string): boolean {
    return this.sessions.has(sessionKey);
  }

  /** Refresh the inactivity timestamp (called once per turn by the hook). */
  touch(sessionKey: string, now: number = Date.now()): void {
    const s = this.sessions.get(sessionKey);
    if (s) s.lastTs = now;
  }

  /**
   * Set/replace the anchor for a session. Preserves `recalledIds` so a drift
   * re-prime still dedups against everything injected earlier in the session.
   */
  upsertAnchor(
    sessionKey: string,
    anchor: { anchorText: string; anchorEmbedding?: number[] },
    now: number = Date.now(),
  ): void {
    const existing = this.sessions.get(sessionKey);
    this.sessions.set(sessionKey, {
      anchorText: anchor.anchorText,
      anchorEmbedding: anchor.anchorEmbedding,
      recalledIds: existing?.recalledIds ?? new Set<string>(),
      lastTs: now,
    });
  }

  mergeRecalledIds(sessionKey: string, ids: string[], now: number = Date.now()): void {
    const s = this.sessions.get(sessionKey);
    if (!s) return;
    for (const id of ids) s.recalledIds.add(id);
    s.lastTs = now;
  }

  /**
   * Compaction safeguard: the transcript (and the injected memory blocks in
   * it) may have been summarized away — reset dedup so the forced re-prime
   * can re-inject still-relevant records.
   */
  clearRecalledIds(sessionKey: string, now: number = Date.now()): void {
    const s = this.sessions.get(sessionKey);
    if (!s) return;
    s.recalledIds.clear();
    s.lastTs = now;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Drop sessions inactive longer than `ttlMs`; bound total size LRU-style. */
  sweep(ttlMs: number, now: number = Date.now(), maxSize: number = DEFAULT_MAX_SESSIONS): void {
    for (const [key, s] of this.sessions) {
      if (now - s.lastTs > ttlMs) this.sessions.delete(key);
    }
    if (this.sessions.size > maxSize) {
      const entries = [...this.sessions.entries()].sort((a, b) => a[1].lastTs - b[1].lastTs);
      for (const [key] of entries.slice(0, entries.length - maxSize)) {
        this.sessions.delete(key);
      }
    }
  }
}

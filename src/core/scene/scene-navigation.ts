/**
 * Scene navigation: view builders over the scene index.
 *
 *   generateActiveScenes  — the legacy "ambient" system-prompt injection view
 *                           (recall.sceneInjection="ambient"): every scene
 *                           whose last_active is within TTL, sorted by
 *                           recency, unlimited count. Each entry carries
 *                           title + activity range + one-line summary +
 *                           pointer scale.
 */

import { escapeXmlTags } from "../../utils/sanitize.js";
import type { SceneIndexEntry } from "./scene-index.js";

/**
 * The system-prompt "active work themes" view.
 *
 * Filter: last_active within `ttlDays` (expired themes are noise — the
 * agent doesn't need them). No top-K cap: TTL alone bounds the list, and
 * a hard cap could evict a genuinely active theme.
 */
export function generateActiveScenes(
  entries: SceneIndexEntry[],
  ttlDays: number,
  now: Date = new Date(),
): string {
  if (entries.length === 0) return "";

  const cutoffMs = ttlDays > 0 ? now.getTime() - ttlDays * 86_400_000 : -Infinity;
  const active = entries
    .filter((e) => {
      const ms = Date.parse(e.last_active || e.updated);
      // Unknown timestamps: keep (can't age them safely) — TTL eviction on
      // disk side is responsible for removing truly stale entries.
      return !Number.isFinite(ms) || ms >= cutoffMs;
    })
    .sort((a, b) => tsMs(b) - tsMs(a));
  if (active.length === 0) return "";

  const lines = active.map((e) => {
    const range = formatRange(e.first_active, e.last_active);
    // Scene index fields ultimately originate from persisted/LLM-generated
    // content and are untrusted at the system <active-scenes> boundary.
    const title = escapeXmlTags(e.title);
    const summary = escapeXmlTags(e.summary);
    const parts = [summary, e.memory_count > 0 ? `记忆: ${e.memory_count}条` : ""].filter(Boolean);
    const detail = parts.join(" | ");
    return detail
      ? `- ${title} (${range})\n  ${detail}`
      : `- ${title} (${range})`;
  });
  return lines.join("\n");
}

function tsMs(e: SceneIndexEntry): number {
  const ms = Date.parse(e.last_active || e.updated);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * "2026-06-28 ~ 08-20" — year shown once unless the range crosses a year
 * boundary relative to the start.
 */
function formatRange(first: string, last: string): string {
  const f = dateOf(first);
  const l = dateOf(last);
  if (!f && !l) return "";
  if (!f) return l!.full;
  if (!l || l.full === f.full) return f.full;
  return l.year === f.year ? `${f.full} ~ ${l.md}` : `${f.full} ~ ${l.full}`;
}

function dateOf(ts: string): { full: string; md: string; year: string } | null {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return { full: `${yyyy}-${mm}-${dd}`, md: `${mm}-${dd}`, year: yyyy };
}

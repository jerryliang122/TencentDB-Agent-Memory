/**
 * Scene navigation: view builders over the scene index.
 *
 *   generateActiveScenes  — the system-prompt injection view: every scene
 *                           whose last_active is within TTL, sorted by
 *                           recency, unlimited count. Each entry carries
 *                           title + activity range + one-line summary +
 *                           pointer scale — the "current work themes"
 *                           awareness signal.
 *
 *   generateSceneNavigation — full index listing (all fields, absolute
 *                           paths) used by the L2 profile sync view.
 */

import path from "node:path";
import type { SceneIndexEntry } from "./scene-index.js";

const NAV_HEADER = "---\n## 🗺️ Scene Navigation (Scene Index)";

const NAV_FOOTER = `📌 使用说明：
- Path 是 scene block 的绝对路径，可直接使用 read_file 读取记忆指针列表
- 记忆详情请用 tdai_memory_search 按主题关键词检索（内容都在 L1）`;

export function generateSceneNavigation(entries: SceneIndexEntry[], dataDir?: string): string {
  if (entries.length === 0) return "";

  const blocks = entries.map((e) => {
    const scenePath = dataDir
      ? path.join(dataDir, "scene_blocks", e.filename)
      : `scene_blocks/${e.filename}`;
    return [
      `### Path: ${scenePath}`,
      `**活动时间**: ${formatRange(e.first_active, e.last_active)}`,
      `**记忆数**: ${e.memory_count}`,
      `Summary: ${e.summary}`,
    ].join("\n");
  });

  return `${NAV_HEADER}\n*以下是当前场景记忆的索引，可根据需要 read_file 读取指针列表。*\n\n${blocks.join("\n\n")}\n\n${NAV_FOOTER}`;
}

/** Strip the scene navigation section from persona content. */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf(NAV_HEADER);
  if (idx === -1) return personaContent;
  return personaContent.slice(0, idx).trimEnd();
}

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
    const parts = [e.summary, e.memory_count > 0 ? `记忆: ${e.memory_count}条` : ""].filter(Boolean);
    const detail = parts.join(" | ");
    return detail
      ? `- ${e.title} (${range})\n  ${detail}`
      : `- ${e.title} (${range})`;
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

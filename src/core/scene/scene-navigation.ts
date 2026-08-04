/**
 * Scene navigation: generates a summary navigation section appended to persona.md.
 *
 * The navigation includes **absolute** file paths so the agent can directly
 * use read_file for on-demand scene loading (progressive disclosure).
 */

import path from "node:path";
import type { SceneIndexEntry } from "./scene-index.js";

const NAV_HEADER = "---\n## 🗺️ Scene Navigation (Scene Index)";

const NAV_FOOTER = `📌 使用说明：
- Path 是 scene block 的绝对路径，可直接使用 read_file 读取完整内容
- 热度：该场景被记忆命中的累计次数，越高越重要
- Summary：场景的核心要点摘要`;

/**
 * Build a fire-emoji string based on heat value (visual priority cue for the agent).
 */
function heatEmoji(heat: number): string {
  if (heat >= 1000) return " 🔥🔥🔥🔥🔥";
  if (heat >= 500) return " 🔥🔥🔥🔥";
  if (heat >= 200) return " 🔥🔥🔥";
  if (heat >= 100) return " 🔥🔥";
  if (heat >= 50) return " 🔥";
  return "";
}

/**
 * Generate the scene navigation Markdown section.
 *
 * @param entries - Scene index entries
 * @param dataDir - Absolute path to the plugin data directory; when provided,
 *                  scene paths are rendered as absolute paths so the agent can
 *                  call read_file directly without path concatenation.
 */
export function generateSceneNavigation(entries: SceneIndexEntry[], dataDir?: string): string {
  if (entries.length === 0) return "";

  const sorted = [...entries].sort((a, b) => b.heat - a.heat);

  const blocks = sorted.map((e) => {
    const scenePath = dataDir
      ? path.join(dataDir, "scene_blocks", e.filename)
      : `scene_blocks/${e.filename}`;
    const pathLine = `### Path: ${scenePath}`;
    const heatLine = `**热度**: ${e.heat}${heatEmoji(e.heat)}${e.updated ? ` | **更新**: ${e.updated}` : ""}`;
    const summaryLine = `Summary: ${e.summary}`;
    return `${pathLine}\n${heatLine}\n${summaryLine}`;
  });

  return `${NAV_HEADER}\n*以下是当前场景记忆的索引，可根据需要 read_file 读取详细内容。*\n\n${blocks.join("\n\n")}\n\n${NAV_FOOTER}`;
}

/**
 * Strip the scene navigation section from persona content.
 */
export function stripSceneNavigation(personaContent: string): string {
  const idx = personaContent.indexOf(NAV_HEADER);
  if (idx === -1) return personaContent;
  return personaContent.slice(0, idx).trimEnd();
}

/**
 * Generate a compact "active scenes" view for L3 system-prompt injection.
 *
 * Differs from generateSceneNavigation in three ways:
 *   1. Only the top-K most-recently-updated scenes (vs. all).
 *   2. Each entry's summary is truncated to `summaryChars` (vs. full).
 *   3. No absolute paths — main agent does not auto-read these; they're
 *      contextual awareness only.
 *
 * Sort key is `updated` (recency), NOT `heat`. Heat is shown for context
 * but does not affect inclusion.
 */
export function generateActiveScenes(
  entries: SceneIndexEntry[],
  topK: number,
  summaryChars: number,
): string {
  if (entries.length === 0) return "";

  const sorted = [...entries].sort((a, b) => {
    const bt = new Date(b.updated).getTime();
    const at = new Date(a.updated).getTime();
    return (Number.isNaN(bt) ? 0 : bt) - (Number.isNaN(at) ? 0 : at);
  });
  const top = sorted.slice(0, Math.max(0, topK));

  const blocks = top.map((e) => {
    const title = e.filename.replace(/\.md$/, "");
    const summary = truncateSummary(e.summary, summaryChars);
    return `### ${title} (热度 ${e.heat})\n${summary}`;
  });

  return blocks.join("\n\n");
}

/**
 * Truncate a summary to `maxChars` Unicode code points, appending a single
 * ellipsis (U+2026) only when truncation actually occurs.
 *
 * Uses `Array.from` for accurate CJK truncation (matches the pattern in
 * `src/core/hooks/auto-recall.ts:truncateHint`).
 */
function truncateSummary(s: string, maxChars: number): string {
  if (!s) return "";
  const cps = Array.from(s);
  if (cps.length <= maxChars) return s;
  return `${cps.slice(0, maxChars).join("").trimEnd()}…`;
}

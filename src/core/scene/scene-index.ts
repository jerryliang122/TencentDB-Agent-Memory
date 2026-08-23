/**
 * Scene Index: maintains a JSON index of all scene blocks for quick lookup.
 *
 * v2 entries are the lightweight "active work theme" projection:
 * filename/title/summary/timestamps/memory_count. The index is written
 * exclusively by the engineering layer (SceneConsolidator / cleaner) —
 * the LLM never touches it.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseSceneFileV2 } from "./scene-format.js";

export interface SceneIndexEntry {
  filename: string;
  title: string;
  summary: string;
  created: string;
  updated: string;
  /** Activity range start (earliest member memory). */
  first_active: string;
  /** Activity range end (latest member memory) — TTL eviction key. */
  last_active: string;
  memory_count: number;
}

/**
 * Read the scene index from disk. Tolerates missing fields (older indexes)
 * and legacy entries that only carry the v1 shape.
 */
export async function readSceneIndex(dataDir: string): Promise<SceneIndexEntry[]> {
  const indexPath = path.join(dataDir, ".metadata", "scene_index.json");
  try {
    const raw = await fs.readFile(indexPath, "utf-8");
    const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
    if (!Array.isArray(parsed)) return [];

    const entries: SceneIndexEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const filename = typeof item.filename === "string" ? item.filename : "";
      if (!filename) continue;
      const str = (key: string): string => (typeof item[key] === "string" ? item[key] as string : "");
      entries.push({
        filename,
        title: str("title") || filename.replace(/\.md$/, ""),
        summary: str("summary"),
        created: str("created"),
        updated: str("updated"),
        first_active: str("first_active") || str("created"),
        last_active: str("last_active") || str("updated"),
        memory_count: typeof item.memory_count === "number" ? item.memory_count : 0,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

/** Write the scene index to disk (atomic). */
export async function writeSceneIndex(
  dataDir: string,
  entries: SceneIndexEntry[],
): Promise<void> {
  const indexPath = path.join(dataDir, ".metadata", "scene_index.json");
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  const tmp = `${indexPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2), "utf-8");
  await fs.rename(tmp, indexPath);
}

/** Rebuild scene index by scanning all v2 scene files in scene_blocks/. */
export async function syncSceneIndex(dataDir: string): Promise<SceneIndexEntry[]> {
  const blocksDir = path.join(dataDir, "scene_blocks");
  let files: string[];
  try {
    files = (await fs.readdir(blocksDir)).filter((f) => f.endsWith(".md"));
  } catch {
    files = [];
  }

  const entries: SceneIndexEntry[] = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(path.join(blocksDir, file), "utf-8");
      const block = parseSceneFileV2(raw);
      if (!block) continue; // legacy file awaiting migration — skip
      entries.push({
        filename: file,
        title: block.meta.title,
        summary: block.meta.summary,
        created: block.meta.created,
        updated: block.meta.updated,
        first_active: block.meta.first_active,
        last_active: block.meta.last_active,
        memory_count: block.meta.memory_count,
      });
    } catch {
      // File may have been deleted between readdir and readFile — skip.
      continue;
    }
  }

  entries.sort((a, b) => (b.last_active || "").localeCompare(a.last_active || ""));
  await writeSceneIndex(dataDir, entries);
  return entries;
}

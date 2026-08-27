/**
 * Public artifacts view over the L2 scene index.
 *
 * Exposes TTL-active scene blocks to the OpenClaw host through
 * MemoryPluginCapability.publicArtifacts so host status/scan surfaces can
 * surface them next to the built-in memory artifacts. Shape mirrors the
 * host's MemoryPluginPublicArtifact contract (validated field-by-field by
 * memory-state.ts before any consumer sees it).
 */

import path from "node:path";
import { readSceneIndex } from "./scene-index.js";

export type MemoryPublicArtifactLike = {
  kind: string;
  workspaceDir: string;
  relativePath: string;
  absolutePath: string;
  agentIds: string[];
  contentType: "markdown" | "json" | "text";
};

export const SCENE_ARTIFACT_KIND = "memory-tencentdb-scene-block";

/**
 * List TTL-active scene blocks as host-visible artifacts.
 *
 * Mirrors the TTL filter in scene-navigation.generateActiveScenes: entries
 * whose last_active is older than ttlDays are skipped; unknown timestamps
 * are kept (disk-side TTL eviction owns truly stale entries).
 */
export async function listSceneBlockArtifacts(params: {
  pluginDataDir: string;
  ttlDays: number;
  now?: Date;
}): Promise<MemoryPublicArtifactLike[]> {
  const now = params.now ?? new Date();
  const entries = await readSceneIndex(params.pluginDataDir).catch(() => []);
  if (entries.length === 0) return [];

  const cutoffMs = params.ttlDays > 0 ? now.getTime() - params.ttlDays * 86_400_000 : -Infinity;
  const artifacts: MemoryPublicArtifactLike[] = [];
  for (const entry of entries) {
    const ms = Date.parse(entry.last_active || entry.updated);
    if (Number.isFinite(ms) && ms < cutoffMs) continue;
    const relativePath = `scene_blocks/${entry.filename}`;
    artifacts.push({
      kind: SCENE_ARTIFACT_KIND,
      workspaceDir: params.pluginDataDir,
      relativePath,
      absolutePath: path.join(params.pluginDataDir, relativePath),
      // Scene blocks are instance-global (not per-agent) memories.
      agentIds: ["*"],
      contentType: "markdown",
    });
  }
  return artifacts;
}

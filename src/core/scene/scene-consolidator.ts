/**
 * Scene Consolidator — the v2 L2 engine.
 *
 * Replaces the old SceneExtractor (LLM agent with file tools). The v2 flow
 * is engineering-driven; the LLM is touched at exactly two points (scene
 * promotion title/summary, summary refresh), both via SceneSynthesizer.
 *
 * Per batch:
 *   1. ensureMigrated()  — v1 narrative files → v2 pointer format (once)
 *   2. archiveExpired()  — TTL (last_active older than ttlDays) → .backup
 *   3. routeMemories()   — cosine(memory, scene anchor) assignments
 *   4. applyAssignments()— merge pointers, update anchors/times, maybe
 *                          refresh summary (LLM, low frequency)
 *   5. accumulate + promote candidates (LLM title/summary on promotion)
 *   6. persist state file + scene files, sync index
 *
 * Machine state (anchors, counters, full memory-id lists) lives in
 * .metadata/scene_state.json; the .md files are the human/tool-facing
 * projection; scene_index.json is derived from the files.
 */

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import type { EmbeddingService } from "../store/embedding.js";
import type { Logger, LLMRunner } from "../types.js";
import {
  formatSceneFileV2,
  migrateLegacyScene,
  parseSceneFileV2,
  sanitizeSceneFilenameStem,
  type ScenePointer,
} from "./scene-format.js";
import { routeMemories, updateAnchor, type RoutableMemory } from "./scene-router.js";
import {
  SceneCandidatePool,
  candidateAnchorCount,
  type SceneCandidate,
} from "./scene-candidates.js";
import { SceneSynthesizer } from "./scene-synthesizer.js";
import { readSceneIndex, syncSceneIndex, writeSceneIndex, type SceneIndexEntry } from "./scene-index.js";

const TAG = "[memory-tdai][consolidator]";
const STATE_FILENAME = "scene_state.json";
const HUSK_ARCHIVE_DIRNAME = "scene_blocks_husks";
const EXPIRED_ARCHIVE_DIRNAME = "scene_blocks_expired";
const POINTER_HEAD_CHARS = 30;

export interface L2Memory {
  id: string;
  content: string;
  sceneName?: string;
  createdAt: string;
  sessionKey?: string;
  embedding?: Float32Array | number[];
}

export interface ConsolidatorOptions {
  dataDir: string;
  config?: unknown;
  model?: string;
  llmRunner?: LLMRunner;
  embeddingService?: EmbeddingService;
  logger?: Logger;
  ttlDays?: number;
  routingThreshold?: number;
  promoteThresholdMemories?: number;
  promoteThresholdSessions?: number;
  candidateTtlDays?: number;
  summaryRefreshDays?: number;
  summaryRefreshNewMemories?: number;
  summaryMaxChars?: number;
}

export interface ConsolidateResult {
  processedMemories: number;
  routedScenes: number;
  promotedScenes: number;
  refreshedSummaries: number;
  expiredArchived: number;
  migrated: number;
  husksArchived: number;
}

interface SceneStateEntry {
  anchor: number[] | null;
  anchorCount: number;
  summaryRefreshedAt: string;
  newSinceRefresh: number;
  memoryIds: string[];
}

interface SceneStateFile {
  migrated: boolean;
  scenes: Record<string, SceneStateEntry>;
}

/** A parsed v2 scene file (meta + pointers). */
type SceneFileEntry = NonNullable<ReturnType<typeof parseSceneFileV2>>;

export class SceneConsolidator {
  private readonly dataDir: string;
  private readonly blocksDir: string;
  private readonly metadataDir: string;
  private readonly logger?: Logger;
  private readonly embeddingService?: EmbeddingService;
  private readonly synthesizer: SceneSynthesizer;
  private readonly ttlDays: number;
  private readonly routingThreshold: number;
  private readonly promoteThresholdMemories: number;
  private readonly promoteThresholdSessions: number;
  private readonly candidateTtlDays: number;
  private readonly summaryRefreshDays: number;
  private readonly summaryRefreshNewMemories: number;

  constructor(opts: ConsolidatorOptions) {
    this.dataDir = opts.dataDir;
    this.blocksDir = path.join(opts.dataDir, "scene_blocks");
    this.metadataDir = path.join(opts.dataDir, ".metadata");
    this.logger = opts.logger;
    this.embeddingService = opts.embeddingService;
    this.synthesizer = new SceneSynthesizer({
      config: opts.config,
      model: opts.model,
      llmRunner: opts.llmRunner,
      logger: opts.logger,
      summaryMaxChars: opts.summaryMaxChars ?? 80,
    });
    this.ttlDays = opts.ttlDays ?? 30;
    this.routingThreshold = opts.routingThreshold ?? 0.55;
    this.promoteThresholdMemories = opts.promoteThresholdMemories ?? 5;
    this.promoteThresholdSessions = opts.promoteThresholdSessions ?? 3;
    this.candidateTtlDays = opts.candidateTtlDays ?? 30;
    this.summaryRefreshDays = opts.summaryRefreshDays ?? 7;
    this.summaryRefreshNewMemories = opts.summaryRefreshNewMemories ?? 5;
  }

  async consolidate(memories: L2Memory[]): Promise<ConsolidateResult> {
    const result: ConsolidateResult = {
      processedMemories: memories.length,
      routedScenes: 0,
      promotedScenes: 0,
      refreshedSummaries: 0,
      expiredArchived: 0,
      migrated: 0,
      husksArchived: 0,
    };

    await fs.mkdir(this.blocksDir, { recursive: true });
    await fs.mkdir(this.metadataDir, { recursive: true });

    const state = await this.loadState();
    const nowIso = new Date().toISOString();

    // Phase 1: one-time migration of legacy v1 files / foreign files.
    // Runs even for empty batches so a plugin upgrade migrates on the first
    // L2 tick regardless of whether new memories arrived.
    if (!state.migrated) {
      const mig = await this.migrateLegacy(state, nowIso);
      result.migrated = mig.migrated;
      result.husksArchived = mig.husksArchived;
      state.migrated = true;
      await this.saveState(state);
    }

    if (memories.length === 0) return result;

    // Phase 2: TTL eviction — archive scenes whose last_active is stale.
    result.expiredArchived = await this.archiveExpired(state, this.ttlDays);

    // Phase 3: deterministic routing.
    const files = await this.readSceneFiles();
    const targets = [...files.entries()].map(([filename, block]) => ({
      filename,
      title: block.meta.title,
      anchor: state.scenes[filename]?.anchor ?? null,
    }));
    const routable: RoutableMemory[] = memories.map((m) => ({
      id: m.id,
      content: m.content,
      sceneName: m.sceneName,
      ts: m.createdAt,
      sessionKey: m.sessionKey,
      embedding: m.embedding,
    }));
    const { assignments, unmatched } = routeMemories(routable, targets, this.routingThreshold);

    // Phase 4: merge assignments into scenes (may refresh summaries via LLM).
    for (const [filename, mems] of assignments) {
      const block = files.get(filename);
      if (!block) continue;
      const refreshed = await this.applyAssignment(filename, block, state, mems, nowIso);
      if (refreshed) result.refreshedSummaries++;
      result.routedScenes++;
    }

    // Phase 5: candidate accumulation + promotion.
    const pool = await SceneCandidatePool.load(this.dataDir, this.logger);
    for (const mem of unmatched) {
      pool.addMemory(
        {
          id: mem.id,
          ts: mem.ts,
          head: pointerHead(mem.content),
          sessionKey: mem.sessionKey ?? "",
          sceneName: mem.sceneName,
          embedding: mem.embedding,
        },
        this.routingThreshold,
      );
    }
    const promotable = pool.findPromotable(this.promoteThresholdMemories, this.promoteThresholdSessions);
    for (const candidate of promotable) {
      const created = await this.promoteCandidate(candidate, state, nowIso);
      if (created) {
        pool.remove(candidate.id);
        result.promotedScenes++;
      }
    }
    const pruned = this.candidateTtlDays > 0
      ? pool.pruneExpired(this.candidateTtlDays)
      : [];
    if (unmatched.length > 0 || promotable.length > 0 || pruned.length > 0) {
      await pool.save();
    }

    // Phase 6: persist state + rewritten files + index.
    await this.saveState(state);
    await this.rebuildIndex();

    this.logger?.info?.(
      `${TAG} consolidate: memories=${memories.length}, routed=${result.routedScenes} scenes, ` +
      `unmatched=${unmatched.length}, promoted=${result.promotedScenes}, refreshed=${result.refreshedSummaries}, ` +
      `expired=${result.expiredArchived}, migrated=${result.migrated}, husks=${result.husksArchived}`,
    );
    return result;
  }

  // ============================
  // Migration (v1 → v2, once)
  // ============================

  private async migrateLegacy(
    state: SceneStateFile,
    nowIso: string,
  ): Promise<{ migrated: number; husksArchived: number }> {
    let migrated = 0;
    let husks = 0;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.blocksDir, { withFileTypes: true });
    } catch {
      return { migrated, husksArchived: husks };
    }

    const huskDir = path.join(this.dataDir, ".backup", HUSK_ARCHIVE_DIRNAME);
    await fs.mkdir(huskDir, { recursive: true });

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = path.join(this.blocksDir, entry.name);

      if (!entry.name.endsWith(".md")) {
        // Foreign file (e.g. an LLM-written shell script) — archive it.
        await fs.rename(filePath, path.join(huskDir, entry.name));
        husks++;
        this.logger?.warn?.(`${TAG} migration: archived non-scene file "${entry.name}"`);
        continue;
      }

      const raw = await fs.readFile(filePath, "utf-8");
      if (parseSceneFileV2(raw)) continue; // already v2

      const { block, healthy } = migrateLegacyScene(raw, entry.name, nowIso);
      if (!healthy) {
        await fs.rename(filePath, path.join(huskDir, entry.name));
        husks++;
        this.logger?.warn?.(`${TAG} migration: archived husk scene "${entry.name}" (wiped/empty body)`);
        continue;
      }

      await fs.writeFile(filePath, formatSceneFileV2(block.meta, []), "utf-8");
      state.scenes[entry.name] = await this.initStateEntry(block.meta.title, block.meta.summary);
      migrated++;
      this.logger?.info?.(
        `${TAG} migration: converted "${entry.name}" to v2 (summary=${block.meta.summary.slice(0, 40)}…)`,
      );
    }
    return { migrated, husksArchived: husks };
  }

  // ============================
  // TTL eviction
  // ============================

  private async archiveExpired(state: SceneStateFile, ttlDays: number): Promise<number> {
    if (!(ttlDays > 0)) return 0;
    const cutoffMs = Date.now() - ttlDays * 86_400_000;
    const files = await this.readSceneFiles();
    let archived = 0;

    for (const [filename, block] of files) {
      const lastMs = Date.parse(block.meta.last_active);
      if (!Number.isFinite(lastMs) || lastMs >= cutoffMs) continue;

      const expiredDir = path.join(this.dataDir, ".backup", EXPIRED_ARCHIVE_DIRNAME);
      await fs.mkdir(expiredDir, { recursive: true });
      const dst = path.join(expiredDir, filename);
      try {
        await fs.copyFile(path.join(this.blocksDir, filename), dst);
        await fs.unlink(path.join(this.blocksDir, filename));
        delete state.scenes[filename];
        archived++;
        this.logger?.info?.(
          `${TAG} TTL eviction: archived "${filename}" (last_active=${block.meta.last_active}, ttl=${ttlDays}d)`,
        );
      } catch (err) {
        this.logger?.warn?.(
          `${TAG} TTL eviction failed for ${filename}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return archived;
  }

  // ============================
  // Assignment application
  // ============================

  private async applyAssignment(
    filename: string,
    block: SceneFileEntry,
    state: SceneStateFile,
    mems: RoutableMemory[],
    nowIso: string,
  ): Promise<boolean> {
    const entry = state.scenes[filename] ?? (state.scenes[filename] = defaultStateEntry());

    // Dedupe against already-recorded pointers.
    const known = new Set([...entry.memoryIds, ...block.pointers.map((p) => p.id)]);
    const fresh = mems.filter((m) => !known.has(m.id));
    if (fresh.length === 0) return false;

    const newPointers: ScenePointer[] = fresh.map((m) => ({
      id: m.id,
      ts: dateOnly(m.ts),
      head: pointerHead(m.content),
    }));

    // Merge pointers: newest first, keep one pointer per id.
    const merged = [...newPointers, ...block.pointers]
      .filter((p, i, arr) => arr.findIndex((q) => q.id === p.id) === i)
      .sort((a, b) => stringTs(b.ts).localeCompare(stringTs(a.ts)));
    entry.memoryIds = [...new Set([...entry.memoryIds, ...fresh.map((m) => m.id)])];

    // Activity range: min/max over member timestamps.
    const times = [block.meta.first_active, block.meta.last_active, ...fresh.map((m) => m.ts)]
      .filter(Boolean)
      .map(stringTs)
      .sort();
    block.meta.first_active = times[0] ?? block.meta.first_active;
    block.meta.last_active = times[times.length - 1] ?? block.meta.last_active;

    // Anchor: incremental running mean.
    const vectors = fresh.map((m) => m.embedding).filter((e): e is Float32Array | number[] => !!e);
    const updated = updateAnchor(entry.anchor, entry.anchorCount, vectors);
    entry.anchor = updated.anchor;
    entry.anchorCount = updated.count;

    // Summary refresh (the only LLM call in the steady-state loop).
    let refreshed = false;
    entry.newSinceRefresh += fresh.length;
    const refreshedAtMs = Date.parse(entry.summaryRefreshedAt);
    const refreshDueByCount = entry.newSinceRefresh >= this.summaryRefreshNewMemories;
    const refreshDueByAge = Number.isFinite(refreshedAtMs)
      && Date.now() - refreshedAtMs >= this.summaryRefreshDays * 86_400_000;
    if ((refreshDueByCount || refreshDueByAge)) {
      const heads = newPointers.map((p) => ({ head: p.head, ts: p.ts }));
      const { summary } = await this.synthesizer.refreshSummary(
        block.meta.title,
        block.meta.summary,
        heads,
      );
      block.meta.summary = summary;
      entry.summaryRefreshedAt = new Date().toISOString();
      entry.newSinceRefresh = 0;
      refreshed = true;
    }

    block.meta.memory_count = entry.memoryIds.length;
    block.meta.updated = nowIso;
    await fs.writeFile(
      path.join(this.blocksDir, filename),
      formatSceneFileV2(block.meta, merged),
      "utf-8",
    );
    return refreshed;
  }

  // ============================
  // Promotion
  // ============================

  private async promoteCandidate(
    candidate: SceneCandidate,
    state: SceneStateFile,
    nowIso: string,
  ): Promise<boolean> {
    try {
      const samples = candidate.memories.map((m) => ({ head: m.head, ts: m.ts }));
      const { title, summary, degraded } = await this.synthesizer.promote(samples);
      if (degraded) {
        this.logger?.warn?.(`${TAG} promotion used degraded (derived) title/summary for "${title}"`);
      }

      const filename = await this.uniqueFilename(title);
      const times = candidate.memories.map((m) => stringTs(m.ts)).filter(Boolean).sort();
      const pointers: ScenePointer[] = candidate.memories.map((m) => ({
        id: m.id,
        ts: dateOnly(m.ts),
        head: m.head,
      })).sort((a, b) => stringTs(b.ts).localeCompare(stringTs(a.ts)));

      const meta = {
        title,
        created: nowIso,
        updated: nowIso,
        first_active: times[0] ?? nowIso,
        last_active: times[times.length - 1] ?? nowIso,
        summary,
        memory_count: pointers.length,
      };
      await fs.writeFile(
        path.join(this.blocksDir, filename),
        formatSceneFileV2(meta, pointers),
        "utf-8",
      );
      state.scenes[filename] = {
        anchor: candidate.anchor,
        anchorCount: candidateAnchorCount(candidate),
        summaryRefreshedAt: nowIso,
        newSinceRefresh: 0,
        memoryIds: candidate.memories.map((m) => m.id),
      };
      this.logger?.info?.(
        `${TAG} promoted candidate → "${filename}" (${candidate.memories.length} memories, ` +
        `${candidate.session_keys.length} sessions)`,
      );
      return true;
    } catch (err) {
      this.logger?.warn?.(
        `${TAG} promotion failed for candidate ${candidate.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private async uniqueFilename(title: string): Promise<string> {
    const stem = sanitizeSceneFilenameStem(title);
    let filename = `${stem}.md`;
    let n = 2;
    while (await fileExists(path.join(this.blocksDir, filename))) {
      filename = `${stem}-${n++}.md`;
    }
    return filename;
  }

  // ============================
  // State + file helpers
  // ============================

  private async initStateEntry(title: string, summary: string): Promise<SceneStateEntry> {
    const entry = defaultStateEntry();
    if (this.embeddingService) {
      try {
        const vec = await this.embeddingService.embed(`${title} ${summary}`.trim());
        entry.anchor = Array.from(vec, (v) => v as number);
        entry.anchorCount = 1;
      } catch {
        // Degraded: text-fallback routing still works.
      }
    }
    return entry;
  }

  private async loadState(): Promise<SceneStateFile> {
    try {
      const raw = await fs.readFile(path.join(this.metadataDir, STATE_FILENAME), "utf-8");
      const parsed = JSON.parse(raw) as SceneStateFile;
      if (parsed && typeof parsed === "object" && parsed.scenes && typeof parsed.migrated === "boolean") {
        return parsed;
      }
    } catch { /* first run */ }
    return { migrated: false, scenes: {} };
  }

  private async saveState(state: SceneStateFile): Promise<void> {
    const tmp = `${path.join(this.metadataDir, STATE_FILENAME)}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state), "utf-8");
    await fs.rename(tmp, path.join(this.metadataDir, STATE_FILENAME));
  }

  private async readSceneFiles(): Promise<Map<string, SceneFileEntry>> {
    const map = new Map<string, SceneFileEntry>();
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.blocksDir, { withFileTypes: true });
    } catch {
      return map;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const raw = await fs.readFile(path.join(this.blocksDir, entry.name), "utf-8");
        const block = parseSceneFileV2(raw);
        if (block) map.set(entry.name, block);
      } catch { /* skip unreadable */ }
    }
    return map;
  }

  /** Rebuild scene_index.json from the v2 files on disk. */
  private async rebuildIndex(): Promise<void> {
    const files = await this.readSceneFiles();
    const entries: SceneIndexEntry[] = [...files.entries()].map(([filename, block]) => ({
      filename,
      title: block.meta.title,
      summary: block.meta.summary,
      created: block.meta.created,
      updated: block.meta.updated,
      first_active: block.meta.first_active,
      last_active: block.meta.last_active,
      memory_count: block.meta.memory_count,
    }));
    entries.sort((a, b) => stringTs(b.last_active).localeCompare(stringTs(a.last_active)));
    await writeSceneIndex(this.dataDir, entries);
  }
}

function defaultStateEntry(): SceneStateEntry {
  return {
    anchor: null,
    anchorCount: 0,
    summaryRefreshedAt: new Date().toISOString(),
    newSinceRefresh: 0,
    memoryIds: [],
  };
}

function pointerHead(content: string): string {
  const normalized = content.replace(/\s*\n\s*/g, " ").trim();
  const chars = Array.from(normalized);
  return chars.length <= POINTER_HEAD_CHARS ? normalized : `${chars.slice(0, POINTER_HEAD_CHARS).join("")}…`;
}

function stringTs(ts: string): string {
  return Date.parse(ts) > 0 ? new Date(Date.parse(ts)).toISOString() : ts;
}

function dateOnly(ts: string): string {
  return /^\d{4}-\d{2}-\d{2}/.exec(ts)?.[0] ?? ts;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Re-exported for pipeline wiring convenience.
export { readSceneIndex, syncSceneIndex };

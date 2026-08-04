import fs from "node:fs/promises";
import path from "node:path";

import type { IMemoryStore } from "../core/store/types.js";
import { parseSceneBlock } from "../core/scene/scene-format.js";
import { syncSceneIndex } from "../core/scene/scene-index.js";
import { ManagedTimer } from "./managed-timer.js";
import type { Logger } from "../core/types.js";
import { formatLocalDateTime, startOfLocalDay } from "./time.js";

export interface MemoryCleanerOptions {
  baseDir: string;
  retentionDays: number;
  cleanTime: string;
  logger?: Logger;
  vectorStore?: IMemoryStore;
  /** L2 scene blocks TTL in days. 0 = skip scene cleanup. Default: 30 */
  sceneTtlDays?: number;
  /** Scene candidate pool TTL in days. 0 = skip candidate cleanup. Default: 30 */
  sceneCandidateTtlDays?: number;
}

interface CleanupStats {
  scannedFiles: number;
  changedFiles: number;
  skippedNonShardFiles: number;
  deleteFailedFiles: number;
}

const TAG = "[memory-tdai][cleaner]";
const L0_DIR_NAME = "conversations";
const L1_DIR_NAME = "records";

/** Minimum records to retain — skip deletion if total is at or below this threshold. */
const MIN_RETAIN_L0 = 50;
const MIN_RETAIN_L1 = 20;

export class LocalMemoryCleaner {
  private readonly timer: ManagedTimer;
  private destroyed = false;
  private vectorStore?: IMemoryStore;

  constructor(private readonly opts: MemoryCleanerOptions) {
    this.timer = new ManagedTimer("memory-tdai-cleaner", () => this.destroyed);
    this.vectorStore = opts.vectorStore;
  }

  setVectorStore(vectorStore: IMemoryStore | undefined): void {
    this.vectorStore = vectorStore;
  }

  start(): void {
    if (this.destroyed) return;

    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    const utcOffset = formatUtcOffset(-now.getTimezoneOffset());

    this.opts.logger?.debug?.(
      `${TAG} Enabled: retentionDays=${this.opts.retentionDays}, cleanTime=${this.opts.cleanTime}, dirs=[${L0_DIR_NAME}, ${L1_DIR_NAME}]`,
    );
    this.opts.logger?.debug?.(
      `${TAG} Runtime clock: nowLocal=${formatLocalDateTime(now)}, nowIso=${now.toISOString()}, tz=${tz}, utcOffset=${utcOffset}`,
    );

    this.scheduleNext();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.timer.cancel();
    this.opts.logger?.info(`${TAG} Stopped`);
  }

  async runOnce(nowMs = Date.now()): Promise<void> {
    if (this.destroyed) return;

    const retentionDays = this.opts.retentionDays;
    if (!(retentionDays > 0)) {
      this.opts.logger?.debug?.(`${TAG} Skip run: invalid retentionDays=${retentionDays}`);
      return;
    }

    // 按"本地自然日"保留策略计算截止时间。
    // 例如 retentionDays=2，今天是 03-15，则保留 03-14/03-15，删除早于 03-14 00:00:00.000 的记录。
    let cutoffMs: number;
    try {
      cutoffMs = computeCutoffMsByLocalDay(nowMs, retentionDays);
    } catch (err) {
      this.opts.logger?.error(`${TAG} ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const targetDirs = [
      path.join(this.opts.baseDir, L0_DIR_NAME),
      path.join(this.opts.baseDir, L1_DIR_NAME),
    ];

    const total: CleanupStats = {
      scannedFiles: 0,
      changedFiles: 0,
      skippedNonShardFiles: 0,
      deleteFailedFiles: 0,
    };

    for (const dirPath of targetDirs) {
      const stats = await this.cleanDirectory(dirPath, cutoffMs);
      total.scannedFiles += stats.scannedFiles;
      total.changedFiles += stats.changedFiles;
      total.skippedNonShardFiles += stats.skippedNonShardFiles;
      total.deleteFailedFiles += stats.deleteFailedFiles;
    }

    if (this.vectorStore) {
      const vectorStore = this.vectorStore;
      const cutoffIso = new Date(cutoffMs).toISOString();
      const startMs = Date.now();

      // ── Pre-delete: count totals and decide whether to proceed ──
      let totalL0 = 0;
      let totalL1 = 0;
      try { totalL0 = await vectorStore.countL0(); } catch { /* non-fatal */ }
      try { totalL1 = await vectorStore.countL1(); } catch { /* non-fatal */ }

      this.opts.logger?.info(
        `${TAG} [Pre-delete] cutoffIso=${cutoffIso}, retentionDays=${retentionDays}, totalL0=${totalL0}, totalL1=${totalL1}`,
      );

      let removedL0 = 0;
      let removedL1 = 0;
      let skippedL0 = false;
      let skippedL1 = false;
      let failedL0DbCleanup = 0;
      let failedL1DbCleanup = 0;

      // ── L0 cleanup with minimum-retention guard ──
      if (totalL0 <= MIN_RETAIN_L0) {
        skippedL0 = true;
        this.opts.logger?.info(
          `${TAG} [L0-delete] SKIPPED: totalL0=${totalL0} <= minRetain=${MIN_RETAIN_L0}`,
        );
      } else {
        try {
          removedL0 = await vectorStore.deleteL0Expired(cutoffIso);
        } catch (err) {
          failedL0DbCleanup = 1;
          this.opts.logger?.warn(
            `${TAG} [L0-delete] FAILED: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // ── L1 cleanup with minimum-retention guard ──
      if (totalL1 <= MIN_RETAIN_L1) {
        skippedL1 = true;
        this.opts.logger?.info(
          `${TAG} [L1-delete] SKIPPED: totalL1=${totalL1} <= minRetain=${MIN_RETAIN_L1}`,
        );
      } else {
        try {
          removedL1 = await vectorStore.deleteL1Expired(cutoffIso);
        } catch (err) {
          failedL1DbCleanup = 1;
          this.opts.logger?.warn(
            `${TAG} [L1-delete] FAILED: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      if (removedL1 > 0 || removedL0 > 0) {
        total.changedFiles += 1;
      }

      // ── Post-delete: audit summary ──
      const durationMs = Date.now() - startMs;
      const remainingL0 = totalL0 - removedL0;
      const remainingL1 = totalL1 - removedL1;
      const summary = {
        event: "cleaner_summary",
        cutoffIso,
        retentionDays,
        l0: { total: totalL0, expired: removedL0, remaining: remainingL0, skipped: skippedL0, failed: failedL0DbCleanup > 0 },
        l1: { total: totalL1, expired: removedL1, remaining: remainingL1, skipped: skippedL1, failed: failedL1DbCleanup > 0 },
        durationMs,
      };
      this.opts.logger?.info(`${TAG} ${JSON.stringify(summary)}`);
    }

    this.opts.logger?.info(
      `${TAG} Cleanup done: scannedFiles=${total.scannedFiles}, changedFiles=${total.changedFiles}, skippedNonShardFiles=${total.skippedNonShardFiles}, deleteFailedFiles=${total.deleteFailedFiles}`,
    );

    // ── L2 scene blocks TTL cleanup ──
    const sceneTtlDays = this.opts.sceneTtlDays ?? 30;
    if (sceneTtlDays > 0) {
      await this.cleanupSceneBlocks(sceneTtlDays, nowMs);
    }

    // ── Scene candidate pool TTL cleanup ──
    const candidateTtlDays = this.opts.sceneCandidateTtlDays ?? 30;
    if (candidateTtlDays > 0) {
      await this.cleanupCandidatePool(candidateTtlDays);
    }

  }

  private scheduleNext(): void {
    const nowMs = Date.now();
    const now = new Date(nowMs);
    const next = nextRunAt(this.opts.cleanTime, nowMs);
    const targetToday = buildTodayRunTime(this.opts.cleanTime, nowMs);
    const passedToday = targetToday <= nowMs;
    const delayMs = Math.max(0, next - nowMs);

    this.opts.logger?.debug?.(
      `${TAG} Schedule next run: nowLocal=${formatLocalDateTime(now)}, cleanTime=${this.opts.cleanTime}, targetTodayLocal=${formatLocalDateTime(new Date(targetToday))}, passedToday=${passedToday}, nextRunLocal=${formatLocalDateTime(new Date(next))}, nextRunIso=${new Date(next).toISOString()}, delayMs=${delayMs}`,
    );

    this.timer.scheduleAt(next, () => {
      const firedAtMs = Date.now();
      this.opts.logger?.info(
        `${TAG} Timer fired: scheduledLocal=${formatLocalDateTime(new Date(next))}, firedLocal=${formatLocalDateTime(new Date(firedAtMs))}, driftMs=${firedAtMs - next}`,
      );
      void this.runAndReschedule();
    });
  }

  private async runAndReschedule(): Promise<void> {
    if (this.destroyed) return;
    const runStart = new Date();
    this.opts.logger?.info(
      `${TAG} Cleanup tick start: nowLocal=${formatLocalDateTime(runStart)}, nowIso=${runStart.toISOString()}`,
    );

    try {
      await this.runOnce();
    } catch (err) {
      this.opts.logger?.error(`${TAG} Cleanup failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    } finally {
      if (!this.destroyed) {
        this.scheduleNext();
      }
    }
  }

  private async cleanDirectory(dirPath: string, cutoffMs: number): Promise<CleanupStats> {
    const stats: CleanupStats = {
      scannedFiles: 0,
      changedFiles: 0,
      skippedNonShardFiles: 0,
      deleteFailedFiles: 0,
    };

    let entries;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {

      this.opts.logger?.debug?.(`${TAG} Directory not found, skip: ${dirPath}`);
      return stats;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!isJsonLikeFile(entry.name)) continue;

      const filePath = path.join(dirPath, entry.name);
      stats.scannedFiles += 1;

      // 仅支持日期分片文件：YYYY-MM-DD(.jsonl/.json)
      const shard = extractShardDateFromFileName(entry.name);
      if (!shard) {
        stats.skippedNonShardFiles += 1;
        this.opts.logger?.debug?.(`${TAG} Skip non-shard file: ${filePath}`);
        continue;
      }

      const dayEndMs = localDayEndMs(shard.year, shard.month, shard.day);
      if (dayEndMs < cutoffMs) {
        try {
          await fs.unlink(filePath);
          stats.changedFiles += 1;
          this.opts.logger?.info(`${TAG} Removed expired file by name: ${filePath}`);
        } catch (err) {
          stats.deleteFailedFiles += 1;
          this.opts.logger?.warn(
            `${TAG} Failed to delete expired shard file ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      } else {
        this.opts.logger?.debug?.(`${TAG} Keep shard file by name: ${filePath}`);
      }
    }

    return stats;
  }

  private async cleanupSceneBlocks(sceneTtlDays: number, nowMs: number): Promise<void> {
    const SCENE_DIR_NAME = "scene_blocks";
    const MIN_RETAIN_SCENES = 3;
    const sceneDir = path.join(this.opts.baseDir, SCENE_DIR_NAME);
    const expiredDir = path.join(this.opts.baseDir, ".backup", "scene_blocks_expired");
    const cutoffMs = nowMs - sceneTtlDays * 86_400_000;

    let files: string[];
    try {
      const entries = await fs.readdir(sceneDir, { withFileTypes: true });
      files = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name);
    } catch {
      this.opts.logger?.debug?.(`${TAG} scene_blocks not present, skipping L2 cleanup`);
      return;
    }

    type SceneInfo = { filename: string; updatedMs: number; heat: number };
    const scenes: SceneInfo[] = [];
    for (const file of files) {
      try {
        const raw = await fs.readFile(path.join(sceneDir, file), "utf-8");
        const block = parseSceneBlock(raw, file);
        const updatedMs = Date.parse(block.meta.updated);
        scenes.push({
          filename: file,
          updatedMs: Number.isFinite(updatedMs) ? updatedMs : 0,
          heat: block.meta.heat,
        });
      } catch {
        // Skip unreadable files
      }
    }

    const byHeat = [...scenes].sort((a, b) => b.heat - a.heat);
    const protectedFilenames = new Set(byHeat.slice(0, MIN_RETAIN_SCENES).map((s) => s.filename));

    const expired = scenes.filter(
      (s) => !protectedFilenames.has(s.filename) && s.updatedMs < cutoffMs,
    );

    if (expired.length === 0) {
      this.opts.logger?.debug?.(`${TAG} L2 cleanup: no expired scenes`);
      return;
    }

    await fs.mkdir(expiredDir, { recursive: true });
    let deleted = 0;
    for (const s of expired) {
      const src = path.join(sceneDir, s.filename);
      const dst = path.join(expiredDir, s.filename);
      try {
        await fs.copyFile(src, dst);
        await fs.unlink(src);
        deleted++;
      } catch (err) {
        this.opts.logger?.warn?.(
          `${TAG} L2 cleanup: failed to remove ${s.filename}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    this.opts.logger?.info?.(
      `${TAG} L2 cleanup: removed ${deleted} expired scenes (retention=${sceneTtlDays}d, retained ${scenes.length - deleted}/${scenes.length})`,
    );

    try {
      await syncSceneIndex(this.opts.baseDir);
    } catch (err) {
      this.opts.logger?.warn?.(
        `${TAG} L2 cleanup: scene index sync failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * Prune expired entries from the scene candidate pool.
   *
   * Candidates that haven't been observed (no new PROPOSE_CANDIDATE signal)
   * for `ttlDays` are removed from `.metadata/scene_candidates.json` so dead
   * topics don't accumulate forever. The pool file is rewritten only when at
   * least one entry was pruned (avoids touching the file on every tick when
   * nothing changed).
   *
   * Fail-soft: errors are logged but do not abort the cleaner tick - a
   * missing/corrupted pool file or read-only data dir must not surface as a
   * hard failure for this non-critical side path (matches cleanupSceneBlocks
   * semantics).
   */
  private async cleanupCandidatePool(ttlDays: number): Promise<void> {
    try {
      const { SceneCandidatePool } = await import("../core/scene/scene-candidates.js");
      const pool = await SceneCandidatePool.load(this.opts.baseDir, this.opts.logger);
      const expired = pool.pruneExpired(ttlDays);
      if (expired.length > 0) {
        await pool.save();
        this.opts.logger?.info?.(
          `${TAG} candidate pool cleanup: pruned ${expired.length} expired candidates (retention=${ttlDays}d)`,
        );
      }
    } catch (err) {
      this.opts.logger?.warn?.(
        `${TAG} candidate pool cleanup error (non-fatal): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}

function isJsonLikeFile(name: string): boolean {
  return name.endsWith(".jsonl") || name.endsWith(".json");
}

function extractShardDateFromFileName(
  fileName: string,
): { year: number; month: number; day: number } | undefined {

  // Supported format: YYYY-MM-DD.jsonl | YYYY-MM-DD.json
  const m = /^(\d{4})-(\d{2})-(\d{2})\.(?:jsonl|json)$/.exec(fileName);
  if (!m) return undefined;

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return undefined;
  }

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }

  const probe = new Date(year, month - 1, day);
  if (
    probe.getFullYear() !== year
    || probe.getMonth() !== month - 1
    || probe.getDate() !== day
  ) {
    return undefined;
  }

  return { year, month, day };
}

function localDayEndMs(year: number, month: number, day: number): number {
  // End of day = start of next day minus 1ms (in configured timezone)
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const nextDayStartMs = startOfLocalDay(nextDay);
  return nextDayStartMs - 1;
}

function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function computeCutoffMsByLocalDay(nowMs: number, retentionDays: number): number {
  // 自然日策略，保留"今天 + 往前 retentionDays-1 天"
  // 删除阈值为 keepStart 当天 00:00:00.000（配置时区）
  const now = new Date(nowMs);
  const todayStartMs = startOfLocalDay(now);
  const cutoffMs = todayStartMs - (retentionDays - 1) * 24 * 60 * 60 * 1000;

  // Sanity check: cutoff must be strictly in the past
  if (cutoffMs >= nowMs) {
    throw new Error(
      `cutoff sanity failed: cutoff (${cutoffMs}) >= now (${nowMs}), ` +
      `possible clock skew or invalid retentionDays=${retentionDays}`,
    );
  }
  // Sanity check: gap between now and cutoff must be at least 24h
  const MIN_GAP_MS = 24 * 60 * 60 * 1000;
  if (nowMs - cutoffMs < MIN_GAP_MS) {
    throw new Error(
      `cutoff sanity failed: gap ${nowMs - cutoffMs}ms < 24h, ` +
      `retentionDays=${retentionDays}, possible clock skew`,
    );
  }

  return cutoffMs;
}

function buildTodayRunTime(cleanTime: string, nowMs: number): number {

  const [hRaw, mRaw] = cleanTime.split(":");
  const hour = Number(hRaw);
  const minute = Number(mRaw);

  const target = new Date(nowMs);
  target.setHours(hour, minute, 0, 0);
  return target.getTime();
}

function nextRunAt(cleanTime: string, nowMs: number): number {

  const [hRaw, mRaw] = cleanTime.split(":");
  const hour = Number(hRaw);
  const minute = Number(mRaw);

  const now = new Date(nowMs);
  const next = new Date(nowMs);
  next.setHours(hour, minute, 0, 0);

  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime();
}

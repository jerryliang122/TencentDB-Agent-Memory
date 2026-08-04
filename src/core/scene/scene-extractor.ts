/**
 * SceneExtractor: LLM-driven memory extraction into scene blocks.
 *
 * Replaces the keyword-based SceneManager.processNewMemories() with an
 * LLM agent that autonomously reads/writes scene block files using tools.
 *
 * Security: The LLM is sandboxed — workspaceDir is set to scene_blocks/
 * so it can ONLY operate on .md scene files. System files (checkpoint,
 * scene_index, persona.md) are physically invisible to the LLM.
 *
 * Flow:
 *   1. Backup + load scene index + build summaries
 *   2. Assemble extraction prompt with memories + scene context
 *   3. Run via CleanContextRunner (tools enabled, sandboxed to scene_blocks/)
 *   4. Cleanup: remove soft-deletes, sync index
 *   5. Parse LLM text output for [PROPOSE_CANDIDATE] signals and update
 *      the SceneCandidatePool; promote candidates meeting thresholds.
 *   6. Engineering guardrails: hard-truncate oversized scene files (5c)
 *      and detect (log-only) suspected merge-bloat (5d).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { formatForLLM } from "../../utils/time.js";
import { CleanContextRunner } from "../../utils/clean-context-runner.js";
import { CheckpointManager } from "../../utils/checkpoint.js";
import { BackupManager } from "../../utils/backup.js";
import { readSceneIndex, syncSceneIndex } from "../scene/scene-index.js";
import type { SceneIndexEntry } from "../scene/scene-index.js";
import { parseSceneBlock } from "../scene/scene-format.js";
import { normalizeSceneFilenames } from "./filename-normalizer.js";
import { enforceSceneLength, detectMergeBloat } from "./scene-guardrails.js";
import { SceneCandidatePool } from "./scene-candidates.js";
import { buildSceneExtractionPrompt } from "../prompts/scene-extraction.js";
import { report } from "../report/reporter.js";
import type { LLMRunner, Logger } from "../types.js";

const TAG = "[memory-tdai] [extractor]";

type ExtractorLogger = Logger;

export interface ExtractionResult {
  memoriesProcessed: number;
  success: boolean;
  error?: string;
}

export interface SceneExtractorOptions {
  dataDir: string;
  config: unknown;
  model?: string;
  maxScenes?: number;
  sceneBackupCount?: number;
  timeoutMs?: number;
  logger?: ExtractorLogger;
  /** Plugin instance ID for metric reporting (optional) */
  instanceId?: string;
  /**
   * Host-neutral LLM runner. When provided, used instead of creating
   * a CleanContextRunner (decouples from OpenClaw runtime).
   * Must be configured with `enableTools: true`.
   */
  llmRunner?: LLMRunner;

  // ── New (L2/L3 redesign) ──
  /** Hard char limit per scene file (default 2000). */
  sceneMaxChars?: number;
  /** UPDATE length growth ratio limit (default 1.5). */
  sceneGrowthLimit?: number;
  /** Candidate pool: memory count threshold (default 5). */
  sceneCreateThresholdMemories?: number;
  /** Candidate pool: session count threshold (default 3). */
  sceneCreateThresholdSessions?: number;
  /**
   * Full rewrite interval in hours. UPDATEs beyond this must use write (full
   * rewrite), not edit (micro). Threaded through to the LLM prompt via
   * `buildSceneExtractionPrompt`. Default 24.
   */
  sceneFullRewriteIntervalHours?: number;
}

/**
 * Parse LLM text output for a persona update request signal.
 *
 * Supports multiple formats for robustness:
 * - Block: [PERSONA_UPDATE_REQUEST]reason: xxx[/PERSONA_UPDATE_REQUEST]
 * - Inline: PERSONA_UPDATE_REQUEST: xxx
 *
 * @deprecated L2/L3 redesign (Task 10) disabled persona-update-signal
 *   forwarding. SceneExtractor no longer calls this function. Retained
 *   for backward compatibility with older logs and external consumers.
 */
export function parsePersonaUpdateSignal(text: string): { reason: string } | null {
  // Block format: [PERSONA_UPDATE_REQUEST]...[/PERSONA_UPDATE_REQUEST]
  const blockMatch = text.match(
    /\[PERSONA_UPDATE_REQUEST\]\s*(?:reason:\s*)?(.+?)\s*\[\/PERSONA_UPDATE_REQUEST\]/s,
  );
  if (blockMatch) return { reason: blockMatch[1]!.trim() };

  // Inline format: PERSONA_UPDATE_REQUEST: reason text
  const inlineMatch = text.match(
    /PERSONA_UPDATE_REQUEST:\s*(.+?)(?:\n|$)/,
  );
  if (inlineMatch) return { reason: inlineMatch[1]!.trim() };

  return null;
}

/**
 * Parse LLM text output for PROPOSE_CANDIDATE signals.
 *
 * Block format:
 *   [PROPOSE_CANDIDATE]
 *   topic: <topic name>
 *   reason: <reason text>
 *   matched_memory_ids: [m_001, m_002]
 *   [/PROPOSE_CANDIDATE]
 *
 * Multiple blocks are supported. Fields `reason` and `matched_memory_ids`
 * are optional (reason defaults to empty string, ids to empty array).
 */
export interface ProposedCandidate {
  topic: string;
  reason: string;
  matched_memory_ids: string[];
}

export function parseProposeCandidateSignals(text: string): ProposedCandidate[] {
  const signals: ProposedCandidate[] = [];
  const blockRe = /\[PROPOSE_CANDIDATE\]\s*([\s\S]*?)\[\/PROPOSE_CANDIDATE\]/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(text)) !== null) {
    const body = m[1] ?? "";
    const topic = extractField(body, "topic");
    if (!topic) continue; // topic is required
    const reason = extractField(body, "reason");
    const idsRaw = extractField(body, "matched_memory_ids");
    const matched_memory_ids = parseIdList(idsRaw);
    signals.push({ topic, reason, matched_memory_ids });
  }
  return signals;
}

function extractField(body: string, field: string): string {
  const re = new RegExp(`^${field}:\\s*(.*)$`, "m");
  const m = body.match(re);
  return m ? m[1]!.trim() : "";
}

function parseIdList(raw: string): string[] {
  if (!raw || raw === "[]") return [];
  // Accept "[m_001, m_002]" or "m_001, m_002" or "m_001"
  const cleaned = raw.replace(/^\[/, "").replace(/\]$/, "").trim();
  if (!cleaned) return [];
  return cleaned.split(/[,\s]+/).filter(Boolean);
}

export class SceneExtractor {
  private dataDir: string;
  private runner: LLMRunner;
  private maxScenes: number;
  private sceneBackupCount: number;
  private timeoutMs: number;
  private logger: ExtractorLogger | undefined;
  private instanceId: string | undefined;
  // L2/L3 redesign guardrail knobs (Task 10)
  private sceneMaxChars: number;
  private sceneGrowthLimit: number;
  private sceneCreateThresholdMemories: number;
  private sceneCreateThresholdSessions: number;
  private sceneFullRewriteIntervalHours: number;

  constructor(opts: SceneExtractorOptions) {
    this.dataDir = opts.dataDir;
    this.maxScenes = opts.maxScenes ?? 15;
    this.sceneBackupCount = opts.sceneBackupCount ?? 10;
    this.timeoutMs = opts.timeoutMs ?? 300_000; // 5 min - LLM may do multiple tool calls
    this.logger = opts.logger;
    this.instanceId = opts.instanceId;
    this.sceneMaxChars = opts.sceneMaxChars ?? 2000;
    this.sceneGrowthLimit = opts.sceneGrowthLimit ?? 1.5;
    this.sceneCreateThresholdMemories = opts.sceneCreateThresholdMemories ?? 5;
    this.sceneCreateThresholdSessions = opts.sceneCreateThresholdSessions ?? 3;
    this.sceneFullRewriteIntervalHours = opts.sceneFullRewriteIntervalHours ?? 24;

    // Use injected LLMRunner if available, otherwise fall back to CleanContextRunner
    this.runner = opts.llmRunner ?? new CleanContextRunner({
      config: opts.config,
      modelRef: opts.model,
      enableTools: true,
      logger: opts.logger,
    });

    this.logger?.debug?.(`${TAG} Created: dataDir=${opts.dataDir}, model=${opts.model ?? "(default)"}, maxScenes=${this.maxScenes}, timeout=${this.timeoutMs}ms`);
  }

  /**
   * Extract a batch of memories into scene blocks using the LLM agent.
   *
   * @param memories - Array of raw memory records from the API
   * @returns Extraction result with count and success flag
   */
  async extract(memories: Array<{ content: string; created_at: string; id?: string }>): Promise<ExtractionResult> {
    const extractStartMs = Date.now();
    this.logger?.info(`${TAG} extract() start: ${memories.length} memories`);

    if (memories.length === 0) {
      this.logger?.debug?.(`${TAG} extract() skipped: no memories`);
      return { memoriesProcessed: 0, success: true };
    }

    const sceneBlocksDir = path.join(this.dataDir, "scene_blocks");
    const metadataDir = path.join(this.dataDir, ".metadata");

    // Ensure directories exist
    await fs.mkdir(sceneBlocksDir, { recursive: true });
    await fs.mkdir(metadataDir, { recursive: true });

    // Phase 1: Backup
    const backupStartMs = Date.now();
    const cpManager = new CheckpointManager(this.dataDir);
    const cp = await cpManager.read();
    const bm = new BackupManager(path.join(this.dataDir, ".backup"));
    await bm.backupDirectory(sceneBlocksDir, "scene_blocks", `offset${cp.total_processed}`, this.sceneBackupCount);
    this.logger?.debug?.(`${TAG} extract() backup phase: ${Date.now() - backupStartMs}ms`);

    // Phase 2: Load scene index
    const indexStartMs = Date.now();
    const index = await readSceneIndex(this.dataDir);
    this.logger?.debug?.(`${TAG} extract() scene index loaded: ${index.length} entries (${Date.now() - indexStartMs}ms)`);

    // Build scene summaries for the prompt (relative filenames only)
    const { summaries: sceneSummaries, filenames: existingSceneFiles } =
      this.buildSceneSummaries(index);

    // Build scene count warning (tiered system)
    let sceneCountWarning: string | undefined;
    const sceneCount = index.length;
    if (sceneCount >= this.maxScenes) {
      sceneCountWarning = `当前场景数量为 **${sceneCount} 个**，已达到或超过 ${this.maxScenes} 个上限！\n**你必须先执行 MERGE 操作**，将最相似的 2-4 个场景合并为 1 个，然后再处理新记忆。\n参考合并对象：热度最低或主题高度重叠的场景。`;
      this.logger?.warn(`${TAG} extract() scene count at limit: ${sceneCount}/${this.maxScenes}`);
    } else if (sceneCount === this.maxScenes - 1) {
      sceneCountWarning = `当前场景数量为 **${sceneCount} 个**，距离上限只差 1 个！\n本次处理**只能 UPDATE 现有场景，不能 CREATE 新场景**。`;
      this.logger?.warn(`${TAG} extract() scene count near limit (CREATE blocked): ${sceneCount}/${this.maxScenes}`);
    } else if (sceneCount >= this.maxScenes - 3) {
      sceneCountWarning = `当前场景数量为 **${sceneCount} 个**，建议优先考虑 UPDATE 或主动 MERGE 相似场景。`;
      this.logger?.debug?.(`${TAG} extract() scene count approaching limit: ${sceneCount}/${this.maxScenes}`);
    }

    // Snapshot scene index + content before LLM — used later to diff created/updated/deleted
    const preExtractIndex = new Map(index.map((e) => [e.filename, e.summary]));
    // Also snapshot scene content so we can detect content-only changes vs metadata-only changes
    const preExtractContent = new Map<string, string>();
    for (const e of index) {
      try {
        const raw = await fs.readFile(path.join(sceneBlocksDir, e.filename), "utf-8");
        const block = parseSceneBlock(raw, e.filename);
        preExtractContent.set(e.filename, block.content);
      } catch { /* non-fatal */ }
    }

    // Phase 3: Build prompt
    const promptStartMs = Date.now();
    const memoriesJson = JSON.stringify(
      memories.map((m) => ({
        content: m.content,
        created_at: m.created_at ? formatForLLM(m.created_at) : m.created_at,
        id: m.id ?? "",
      })),
      null,
      2,
    );

    const currentTimestamp = formatTimestamp(new Date());

    const { systemPrompt, userPrompt } = buildSceneExtractionPrompt({
      memoriesJson,
      sceneSummaries: sceneSummaries || "(无已有场景)",
      currentTimestamp,
      sceneCountWarning,
      existingSceneFiles,
      maxScenes: this.maxScenes,
      sceneFullRewriteIntervalHours: this.sceneFullRewriteIntervalHours,
    });
    this.logger?.debug?.(`${TAG} extract() prompt built: ${userPrompt.length} chars (${Date.now() - promptStartMs}ms)`);

    // Phase 4: Run LLM agent (sandboxed to scene_blocks/)
    let llmOutput = "";
    let llmDurationMs = 0;
    try {
      this.logger?.debug?.(`${TAG} extract() starting LLM runner (timeout=${this.timeoutMs}ms, maxTokens=model default)...`);
      const runnerStartMs = Date.now();
      llmOutput = await this.runner.run({
        systemPrompt,
        prompt: userPrompt,
        taskId: `scene-extract-${Date.now()}`,
        timeoutMs: this.timeoutMs,
        // maxTokens omitted → core uses the resolved model's maxTokens from catalog
        workspaceDir: sceneBlocksDir,
      }) ?? "";
      llmDurationMs = Date.now() - runnerStartMs;
      this.logger?.debug?.(`${TAG} extract() LLM runner completed: ${llmDurationMs}ms`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const totalMs = Date.now() - extractStartMs;
      this.logger?.error(`${TAG} extract() LLM runner failed after ${totalMs}ms: ${errMsg}`);

      // Restore scene_blocks/ from the Phase 1 backup so partial LLM writes
      // (or a wiped sandbox) don't leak into the next recall cycle.
      // Fail-soft: a restore failure must never mask the original LLM error.
      try {
        const result = await bm.restoreLatestDirectory("scene_blocks", sceneBlocksDir);
        if (result.restored) {
          this.logger?.warn(`${TAG} extract() restored scene_blocks/ from backup: ${result.from}`);
        } else {
          this.logger?.debug?.(`${TAG} extract() no scene_blocks backup to restore from (first run or empty)`);
        }
      } catch (restoreErr) {
        const rMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
        this.logger?.warn(`${TAG} extract() restore failed (non-fatal, original LLM error preserved): ${rMsg}`);
      }

      return { memoriesProcessed: 0, success: false, error: errMsg };
    }

    // Phase 5: Subsequent processing — safe cleanup of soft-deleted files
    //
    // Security: The LLM has no `exec` tool and cannot run shell commands.
    // Instead, it "deletes" files by writing the marker `[DELETED]` to the file
    // (writing empty/whitespace-only content is rejected by core's write tool
    // parameter validation). Here we detect and remove those soft-deleted files
    // before syncing the index, so syncSceneIndex won't re-index stale entries.
    //
    // We also detect "META-only" files — files that contain only a META header
    // (e.g. [ARCHIVE] or [CONSOLIDATED] markers) but no actual scene content.
    // These are artifacts of LLM merges that didn't properly delete old files.
    const cleanupStartMs = Date.now();
    let cleanedCount = 0;
    try {
      const allFiles = (await fs.readdir(sceneBlocksDir)).filter((f) => f.endsWith(".md"));
      for (const file of allFiles) {
        const filePath = path.join(sceneBlocksDir, file);
        const raw = await fs.readFile(filePath, "utf-8");
        if (raw.trim().length === 0 || raw.trim() === "[DELETED]") {
          // Empty file or [DELETED] marker — soft-delete
          await fs.unlink(filePath);
          cleanedCount++;
          this.logger?.debug?.(`${TAG} extract() removed soft-deleted file: ${file}`);
        } else {
          // Check if file has only META header but no actual content
          const block = parseSceneBlock(raw, file);
          if (!block.content || block.content.trim().length === 0) {
            await fs.unlink(filePath);
            cleanedCount++;
            this.logger?.debug?.(`${TAG} extract() removed META-only file (no content): ${file}`);
          }
        }
      }
    } catch (cleanupErr) {
      // Non-fatal — log and continue to index sync
      this.logger?.warn(`${TAG} extract() soft-delete cleanup error: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
    }
    this.logger?.debug?.(`${TAG} extract() soft-delete cleanup: removed ${cleanedCount} empty files (${Date.now() - cleanupStartMs}ms)`);

    // Phase 5b: Normalize filenames (defensive — LLM occasionally produces names
    // with spaces / punctuation despite the prompt forbidding them, e.g.
    // "Daily Rhythm in Shanghai.md". Such names break downstream consumers
    // that parse Markdown navigation refs with `\S+\.md` style regexes
    // (health-checker), shell tools, and URL-encoded path consumers.
    //
    // Renaming here — *before* syncSceneIndex — means scene_index.json and
    // every downstream reader (PersonaGenerator, recall, profile-sync) only
    // ever sees canonical filenames. Idempotent and safe to run repeatedly.
    const normStartMs = Date.now();
    try {
      const normResult = await normalizeSceneFilenames(sceneBlocksDir, this.logger);
      if (normResult.renamed > 0) {
        this.logger?.info(
          `${TAG} extract() filename normalization: renamed ${normResult.renamed}, skipped ${normResult.skipped} (${Date.now() - normStartMs}ms)`,
        );
      } else {
        this.logger?.debug?.(
          `${TAG} extract() filename normalization: skipped ${normResult.skipped} (${Date.now() - normStartMs}ms)`,
        );
      }
    } catch (normErr) {
      // Non-fatal — log and continue. Index sync below will simply pick up
      // whatever names are present on disk.
      this.logger?.warn(`${TAG} extract() filename normalization error: ${normErr instanceof Error ? normErr.message : String(normErr)}`);
    }

    // Phase 5c: Length enforcement — hard truncation of over-limit scene files.
    // Defensive: LLM may ignore prompt-level length guidance; this guarantees
    // an absolute upper bound on each scene file's char count.
    const lenStartMs = Date.now();
    let truncatedCount = 0;
    try {
      const allFiles = (await fs.readdir(sceneBlocksDir)).filter((f) => f.endsWith(".md"));
      for (const file of allFiles) {
        const filePath = path.join(sceneBlocksDir, file);
        const raw = await fs.readFile(filePath, "utf-8");
        const result = enforceSceneLength(raw, this.sceneMaxChars);
        if (result.truncated) {
          await fs.writeFile(filePath, result.output, "utf-8");
          truncatedCount++;
          this.logger?.warn(
            `${TAG} extract() truncated ${file}: ${result.originalLength} → ${result.output.length} chars`,
          );
        }
      }
    } catch (lenErr) {
      this.logger?.warn?.(
        `${TAG} extract() length enforcement error: ${lenErr instanceof Error ? lenErr.message : String(lenErr)}`,
      );
    }
    this.logger?.debug?.(
      `${TAG} extract() length enforcement: truncated ${truncatedCount} files (${Date.now() - lenStartMs}ms)`,
    );

    // Phase 5d: Merge bloat detection — detect (log-only) scenes suspected of
    // pure-append bloat. Actual rollback is deferred: BackupManager only
    // supports `restoreLatestDirectory` (whole scene_blocks/), not per-file
    // restore, so a single bloated file cannot be surgically reverted without
    // clobbering legitimate concurrent writes to other files.
    const bloatStartMs = Date.now();
    let suspectedCount = 0;
    try {
      for (const [filename, oldContent] of preExtractContent) {
        const filePath = path.join(sceneBlocksDir, filename);
        let newRaw: string;
        try {
          newRaw = await fs.readFile(filePath, "utf-8");
        } catch {
          continue; // File deleted in Phase 5 — nothing to compare.
        }
        const newBlock = parseSceneBlock(newRaw, filename);
        const detection = detectMergeBloat(oldContent, newBlock.content, this.sceneGrowthLimit);
        if (detection.suspected) {
          suspectedCount++;
          this.logger?.warn(
            `${TAG} extract() merge bloat suspected for ${filename}: ${detection.reason} — manual review needed`,
          );
          // TODO(v2): single-file restore requires BackupManager.restoreLatestFile
          // (not yet implemented). When available, restore this file from the
          // Phase 1 backup instead of just warning.
        }
      }
    } catch (bloatErr) {
      this.logger?.warn?.(
        `${TAG} extract() bloat detection error: ${bloatErr instanceof Error ? bloatErr.message : String(bloatErr)}`,
      );
    }
    this.logger?.debug?.(
      `${TAG} extract() bloat detection: ${suspectedCount} suspected files (${Date.now() - bloatStartMs}ms)`,
    );

    // Phase 6: Sync scene index (rebuilds from remaining non-empty files)
    const syncStartMs = Date.now();
    await syncSceneIndex(this.dataDir);
    this.logger?.debug?.(`${TAG} extract() scene index synced: ${Date.now() - syncStartMs}ms`);

    // Phase 8: Parse LLM output for PROPOSE_CANDIDATE signals and update
    // the SceneCandidatePool; promote candidates meeting thresholds.
    //
    // Replaces the old persona-update-signal forwarding (L3 redesign disabled
    // PersonaUpdateRequest plumbing on the SceneExtractor side).
    //
    // Fail-soft: candidate pool errors don't fail the extraction. The LLM
    // extraction itself succeeded; a corrupt pool or read-only / quota-exhausted
    // data dir must not surface as a hard failure for this non-critical side path
    // (matches Phase 5c/5d warn-and-continue semantics).
    if (llmOutput) {
      try {
        const proposals = parseProposeCandidateSignals(llmOutput);
        if (proposals.length > 0) {
          const pool = await SceneCandidatePool.load(this.dataDir, this.logger);
          for (const p of proposals) {
            // The LLM signal does not carry per-memory session info, so we use
            // a placeholder session key. The session threshold is therefore
            // approximate at v1; a future tightening passes sessionKey through
            // extract() opts.
            const sessionKey = "unknown-session";
            const ids = p.matched_memory_ids.length > 0
              ? p.matched_memory_ids
              : memories.slice(0, 1).map((m) => m.id ?? "").filter(Boolean);
            for (const memId of ids) {
              if (memId) pool.addObservation(p.topic, memId, sessionKey, p.reason);
            }
          }
          await pool.save();
          this.logger?.debug?.(
            `${TAG} extract() processed ${proposals.length} PROPOSE_CANDIDATE signals`,
          );

          // Phase 8b: Promote candidates meeting thresholds - create stub scene
          // files. v1 writes a stub directly (no LLM call); the next LLM
          // extraction sees this new file in the scene list and treats it as a
          // normal scene to UPDATE (or leaves alone if no related memories in
          // the current batch). Over time, as new memories about the topic
          // arrive, the LLM populates the narrative.
          // v2 (spec §3.1 "特殊 LLM 调用"): replace stub with a dedicated LLM
          // call over the candidate's accumulated L1 content.
          const promotable = pool.findPromotable(
            this.sceneCreateThresholdMemories,
            this.sceneCreateThresholdSessions,
          );
          for (const candidate of promotable) {
            this.logger?.info(
              `${TAG} extract() promoting candidate "${candidate.topic}" to formal scene ` +
              `(${candidate.matched_memory_ids.length} mems, ${candidate.session_keys.length} sessions)`,
            );
            try {
              const stubFilename = `${sanitizeFilename(candidate.topic)}.md`;
              const stubPath = path.join(sceneBlocksDir, stubFilename);
              const nowIso = new Date().toISOString();
              const stubContent = `-----META-START-----
created: ${nowIso}
updated: ${nowIso}
summary: ${candidate.topic} (auto-promoted from candidate pool, pending first LLM extraction)
heat: ${candidate.matched_memory_ids.length}
last_full_rewrite_at: ${nowIso}
-----META-END-----

# ${candidate.topic}

This scene was auto-created from the candidate pool after accumulating
${candidate.matched_memory_ids.length} memory observations across
${candidate.session_keys.length} sessions. Pending first LLM extraction
to populate narrative content.

## Matched Memory IDs
${candidate.matched_memory_ids.map((id) => `- ${id}`).join("\n")}

## Recent Proposals
${candidate.recent_proposals.map((p) => `- ${p}`).join("\n")}
`;
              await fs.writeFile(stubPath, stubContent, "utf-8");
              pool.remove(candidate.topic);
              this.logger?.info(`${TAG} extract() created stub scene: ${stubFilename}`);
            } catch (err) {
              this.logger?.warn?.(
                `${TAG} extract() failed to promote candidate "${candidate.topic}": ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }
          }
          await pool.save();
        }
      } catch (err) {
        this.logger?.warn?.(
          `${TAG} extract() candidate pool error (non-fatal): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    const totalMs = Date.now() - extractStartMs;
    this.logger?.info(`${TAG} extract() completed: ${memories.length} memories processed in ${totalMs}ms`);

    // ── l2_extraction metric ──
    if (this.instanceId && this.logger) {
      // Read updated scene index to report final state + diff against pre-extract snapshot
      let resultScenes: Array<{ title: string; summary: string; content: string; status: "created" | "updated" }> = [];
      let scenesCreated = 0;
      let scenesUpdated = 0;
      let scenesDeleted = 0;
      try {
        const finalIndex = await readSceneIndex(this.dataDir);
        const postFilenames = new Set<string>();
        for (const e of finalIndex) {
          postFilenames.add(e.filename);
          const oldSummary = preExtractIndex.get(e.filename);
          // Read scene block content from disk
          let content = "";
          try {
            const blockPath = path.join(sceneBlocksDir, e.filename);
            const raw = await fs.readFile(blockPath, "utf-8");
            const block = parseSceneBlock(raw, e.filename);
            content = block.content;
          } catch { /* file read failure is non-fatal */ }

          if (oldSummary === undefined) {
            // New scene
            scenesCreated++;
            resultScenes.push({
              title: e.filename.replace(/\.md$/, ""),
              summary: e.summary,
              content,
              status: "created",
            });
          } else {
            // Existing scene — check if content actually changed (not just metadata)
            const oldContent = preExtractContent.get(e.filename) ?? "";
            if (content !== oldContent) {
              scenesUpdated++;
              resultScenes.push({
                title: e.filename.replace(/\.md$/, ""),
                summary: e.summary,
                content,
                status: "updated",
              });
            }
            // If only metadata (summary/heat) changed but content is the same, skip
          }
        }
        // Scenes in pre-extract but missing from post-extract = deleted
        for (const [filename] of preExtractIndex) {
          if (!postFilenames.has(filename)) {
            scenesDeleted++;
          }
        }
      } catch { /* non-fatal */ }

      report("l2_extraction", {
        inputMemoryCount: memories.length,
        resultSceneCount: resultScenes.length,
        resultScenes,
        scenesCreated,
        scenesUpdated,
        scenesDeleted,
        llmDurationMs,
        totalDurationMs: totalMs,
        success: true,
        error: null,
      });
    }

    return { memoriesProcessed: memories.length, success: true };
  }

  /**
   * Build human-readable scene summaries for the prompt,
   * and collect the list of existing scene filenames (relative).
   *
   * Includes a capacity counter at the top (e.g. "当前场景总数：5 / 15")
   * so the LLM can immediately see how close it is to the limit.
   */
  private buildSceneSummaries(
    index: SceneIndexEntry[],
  ): { summaries: string; filenames: string[] } {
    if (index.length === 0) return { summaries: "", filenames: [] };

    const lines: string[] = [];
    const filenames: string[] = [];

    // Inject capacity counter at the top — LLM sees this first
    lines.push(`**当前场景总数：${index.length} / ${this.maxScenes}**`);
    lines.push("");

    for (const entry of index) {
      filenames.push(entry.filename);
      lines.push(`### ${entry.filename}`);
      lines.push(`**热度**: ${entry.heat} | **更新**: ${entry.updated}`);
      lines.push(`**summary**: ${entry.summary}`);
      lines.push("");
    }
    return { summaries: lines.join("\n"), filenames };
  }
}

function formatTimestamp(d: Date): string {
  return formatForLLM(d);
}

/**
 * Sanitize a candidate topic into a filesystem-safe stem (no extension).
 *
 * Used by Phase 8b when promoting a candidate to a stub scene file. Mirrors
 * the allowed-charset rules of `normalizeSceneFilename` from
 * `filename-normalizer.ts` (Unicode letters/numbers + `-`/`_`/`.`) but
 * operates on a topic string (which may contain spaces, slashes, brackets)
 * rather than an existing filename.
 *
 * Rules:
 *   - Whitespace runs (incl. NBSP, full-width space) -> single hyphen.
 *   - Drop quotes, brackets, and shell/markdown-breaking punctuation.
 *   - Collapse consecutive separators.
 *   - Trim leading / trailing separators.
 *   - Fall back to "scene" if the stem becomes empty.
 *
 * Examples:
 *   "Rust 学习"          -> "Rust-学习"
 *   "Daily Rhythm"       -> "Daily-Rhythm"
 *   "Coffee (Yirgacheffe)" -> "Coffee-Yirgacheffe"
 *   "a/b\\c"              -> "abc"  (slashes dropped, no separator injected)
 */
export function sanitizeFilename(topic: string): string {
  if (!topic) return "scene";
  const safe = topic
    .replace(/[\s\u00A0\u3000]+/g, "-")
    .replace(/[()[\]{}<>'"`,;:!?*|/\\=&%$#@^~+]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/_{2,}/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-_.]+|[-_.]+$/g, "");
  return safe || "scene";
}

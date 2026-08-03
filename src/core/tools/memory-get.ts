/**
 * memory_get tool: Agent-callable tool for fetching a single L1 memory record
 * by its `record_id`.
 *
 * Companion to the new "subject-only" auto-recall injection format:
 *   - [type|scene] content首N字… (活动时间: ...) [id=m_xxx]
 *
 * When the main agent decides it needs the full content of a recalled memory,
 * it calls `tdai_memory_get(record_id="m_xxx")` to retrieve it on demand
 * instead of having the full content injected into the prompt up front.
 *
 * The tool is registered via `api.registerTool()` in index.ts alongside
 * `tdai_memory_search` and `tdai_conversation_search`.
 */

import type { IMemoryStore, L1RecordRow } from "../store/types.js";
import type { Logger } from "../types.js";

const TAG = "[memory-tdai][tdai_memory_get]";

// ============================
// Types
// ============================

export interface MemoryGetResult {
  found: boolean;
  record?: L1RecordRow;
  /** Optional record_id for friendlier "not found" messages. */
  recordIdHint?: string;
}

// ============================
// Tool implementation
// ============================

export async function executeMemoryGet(params: {
  recordId: string;
  vectorStore?: IMemoryStore;
  logger?: Logger;
}): Promise<MemoryGetResult> {
  const { recordId: rawId, vectorStore, logger } = params;

  // 1. Validate input — empty / whitespace recordId short-circuits without
  //    touching the store. Keeps the call cheap when the LLM hallucinates
  //    an empty ID.
  const recordId = rawId?.trim();
  if (!recordId) {
    logger?.debug?.(`${TAG} empty record_id, returning not-found`);
    return { found: false, recordIdHint: rawId };
  }

  // 2. Store missing — degraded mode (vectorStore init failed at startup).
  if (!vectorStore) {
    logger?.warn?.(`${TAG} vectorStore unavailable, cannot fetch record_id=${recordId}`);
    return { found: false, recordIdHint: recordId };
  }

  // 3. Fetch + fault-tolerant wrapping. Store implementations are contractually
  //    required to return null on miss (not throw), but we keep the catch as a
  //    defense against unexpected store-level errors (e.g. SQLite disk I/O).
  try {
    const row = await vectorStore.getL1ById(recordId);
    if (!row) {
      logger?.debug?.(`${TAG} record_id=${recordId} not found (deleted/merged?)`);
      return { found: false, recordIdHint: recordId };
    }
    logger?.debug?.(
      `${TAG} HIT record_id=${recordId}, contentLen=${row.content.length}, ` +
      `type=${row.type}, scene="${row.scene_name || "(none)"}"`,
    );
    return { found: true, record: row };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger?.error(`${TAG} getL1ById threw for record_id=${recordId}: ${errMsg}`);
    return { found: false, recordIdHint: recordId };
  }
}

// ============================
// Tool response formatter
// ============================

export function formatMemoryGetResponse(result: MemoryGetResult): string {
  if (!result.found || !result.record) {
    const hint = result.recordIdHint ? `(record_id=${result.recordIdHint})` : "";
    return `Memory not found ${hint}. It may have been deleted, merged into another record, or the record_id is incorrect. ` +
      `Try tdai_memory_search to find the current record by content/scene.`;
  }

  const r = result.record;

  // Render activity time range from metadata_json if present.
  let activityInfo = "";
  if (r.metadata_json && r.metadata_json !== "{}") {
    try {
      const meta = JSON.parse(r.metadata_json) as {
        activity_start_time?: string;
        activity_end_time?: string;
      };
      if (meta.activity_start_time || meta.activity_end_time) {
        const s = meta.activity_start_time ?? "?";
        const e = meta.activity_end_time ?? "?";
        activityInfo = `\n活动时间: ${s} ~ ${e}`;
      }
    } catch {
      // malformed metadata_json — skip activity info silently
    }
  }

  // Priority: -1 is the sentinel for "strict global instruction" (see l1-writer.ts).
  const priorityStr = r.priority === -1
    ? "global instruction"
    : `priority: ${r.priority}`;

  const sceneStr = r.scene_name ? ` [scene: ${r.scene_name}]` : "";

  const lines: string[] = [
    `**[${r.type}]**${sceneStr} (${priorityStr}) [id: ${r.record_id}]`,
    ``,
    r.content,
  ];

  if (activityInfo) {
    lines.push(``, activityInfo);
  }

  lines.push(
    ``,
    `---`,
    `_Created: ${r.created_time || "(unknown)"} · Updated: ${r.updated_time || "(unknown)"}_`,
  );

  return lines.join("\n");
}

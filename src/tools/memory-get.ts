/**
 * memory_get tool: Agent-callable tool for fetching a single L1 memory record.
 */

import type { IMemoryStore, L1RecordRow } from "../core/store/types.js";
import type { Logger } from "../core/types.js";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import type { MemoryToolOptions } from "./common.js";

export interface MemoryGetResult {
  found: boolean;
  record?: L1RecordRow;
  recordIdHint?: string;
}

export interface SanitizedToolError {
  userMessage: string;
  errorCode: string;
  internalError: string;
}

const TOOL_ERROR_USER_MESSAGE =
  "Memory get failed: internal error. Try tdai_memory_search to find the memory by content/scene instead.";

export function sanitizeToolError(err: unknown): SanitizedToolError {
  let internalError: string;
  if (err instanceof Error) {
    internalError = err.message;
  } else if (typeof err === "string") {
    internalError = err;
  } else if (err == null) {
    internalError = String(err);
  } else {
    try {
      internalError = JSON.stringify(err);
    } catch {
      internalError = String(err);
    }
  }
  return { userMessage: TOOL_ERROR_USER_MESSAGE, errorCode: "internal_error", internalError };
}

export async function executeMemoryGet(params: {
  recordId: string;
  vectorStore?: IMemoryStore;
  logger?: Logger;
}): Promise<MemoryGetResult> {
  const { recordId: rawId, vectorStore, logger } = params;

  const recordId = rawId?.trim();
  if (!recordId) {
    return { found: false, recordIdHint: rawId };
  }

  if (!vectorStore) {
    return { found: false, recordIdHint: recordId };
  }

  try {
    const row = await vectorStore.getL1ById(recordId);
    if (!row) {
      return { found: false, recordIdHint: recordId };
    }
    return { found: true, record: row };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger?.error?.(`getL1ById threw for record_id=${recordId}: ${errMsg}`);
    return { found: false, recordIdHint: recordId };
  }
}

export function formatMemoryGetResponse(result: MemoryGetResult): string {
  if (!result.found || !result.record) {
    const hint = result.recordIdHint ? `(record_id=${result.recordIdHint})` : "";
    return `Memory not found ${hint}. Try tdai_memory_search to find the current record by content/scene.`;
  }

  const r = result.record;

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
    } catch {}
  }

  const priorityStr = r.priority === -1 ? "global instruction" : `priority: ${r.priority}`;
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

export function createMemoryGetTool(options: MemoryToolOptions): AnyAgentTool {
  return {
    label: "Memory Get",
    name: "tdai_memory_get",
    description: "Fetch a specific memory record by its ID. Use this when you have a memory ID from auto-recall and need the full content.",
    parameters: {
      type: "object",
      properties: {
        record_id: { type: "string", description: "The ID of the memory record to fetch (e.g., m_xxx)" },
      },
      required: ["record_id"],
    },
    async execute(_toolCallId, params) {
      const recordId = String(params.record_id ?? "");

      try {
        const result = await executeMemoryGet({
          recordId,
          vectorStore: options.vectorStore,
          logger: options.logger,
        });
        return {
          content: [{ type: "text", text: formatMemoryGetResponse(result) }],
          details: { found: result.found },
        };
      } catch (err) {
        const sanitized = sanitizeToolError(err);
        return {
          content: [{ type: "text", text: sanitized.userMessage }],
          details: { error: sanitized.internalError },
        };
      }
    },
  };
}

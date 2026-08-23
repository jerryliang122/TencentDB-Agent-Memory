/**
 * memory_search tool: Agent-callable tool for searching L1 memory records.
 */

import type { IMemoryStore, L1SearchResult } from "../core/store/types.js";
import { buildFtsQuery } from "../core/store/sqlite.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import type { Logger } from "../core/types.js";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { rrfMerge } from "../core/search/rrf.js";
import { report } from "../core/report/reporter.js";
import type { MemoryToolOptions } from "./common.js";

export interface MemorySearchResultItem {
  id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  score: number;
  created_at: string;
  updated_at: string;
}

export interface MemorySearchResult {
  results: MemorySearchResultItem[];
  total: number;
  strategy: string;
  message?: string;
}

export async function executeMemorySearch(params: {
  query: string;
  limit: number;
  type?: string;
  scene?: string;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
}): Promise<MemorySearchResult> {
  const { query, limit, type: typeFilter, scene: sceneFilter, vectorStore, embeddingService, logger } = params;

  if (!query || query.trim().length === 0) {
    return { results: [], total: 0, strategy: "none" };
  }

  if (!vectorStore) {
    return { results: [], total: 0, strategy: "none" };
  }

  const hasEmbedding = !!embeddingService;
  const hasFts = vectorStore.isFtsAvailable();

  if (!hasEmbedding && !hasFts) {
    return {
      results: [],
      total: 0,
      strategy: "none",
      message: "Embedding service is not configured and FTS is not available.",
    };
  }

  const candidateK = limit * 3;

  const [ftsItems, vecItems] = await Promise.all([
    (async (): Promise<MemorySearchResultItem[]> => {
      if (!hasFts) return [];
      try {
        const ftsQuery = buildFtsQuery(query);
        if (!ftsQuery) return [];
        const ftsResults = await vectorStore.searchL1Fts(ftsQuery, candidateK);
        return ftsResults.map((r) => ({
          id: r.record_id,
          content: r.content,
          type: r.type,
          priority: r.priority,
          scene_name: r.scene_name,
          score: r.score,
          created_at: r.timestamp_start,
          updated_at: r.timestamp_end,
        }));
      } catch {
        return [];
      }
    })(),
    (async (): Promise<MemorySearchResultItem[]> => {
      if (!hasEmbedding) return [];
      try {
        const queryEmbedding = await embeddingService!.embed(query);
        const vecResults: L1SearchResult[] = await vectorStore.searchL1Vector(queryEmbedding, candidateK, query);
        return vecResults.map((r) => ({
          id: r.record_id,
          content: r.content,
          type: r.type,
          priority: r.priority,
          scene_name: r.scene_name,
          score: r.score,
          created_at: r.timestamp_start,
          updated_at: r.timestamp_end,
        }));
      } catch {
        return [];
      }
    })(),
  ]);

  const ftsOk = ftsItems.length > 0;
  const vecOk = vecItems.length > 0;
  let strategy: string;

  if (ftsOk && vecOk) {
    strategy = "hybrid";
  } else if (vecOk) {
    strategy = "embedding";
  } else if (ftsOk) {
    strategy = "fts";
  } else {
    return { results: [], total: 0, strategy: hasEmbedding ? "embedding" : "fts" };
  }

  let results: MemorySearchResultItem[];
  if (strategy === "hybrid") {
    results = rrfMerge(ftsItems, vecItems);
  } else {
    results = ftsOk ? ftsItems : vecItems;
  }

  if (typeFilter) {
    results = results.filter((r) => r.type === typeFilter);
  }
  if (sceneFilter) {
    const normalizedScene = sceneFilter.toLowerCase();
    results = results.filter((r) => r.scene_name.toLowerCase().includes(normalizedScene));
  }

  const trimmed = results.slice(0, limit);
  return { results: trimmed, total: trimmed.length, strategy };
}

export function formatSearchResponse(result: MemorySearchResult): string {
  if (result.message) return result.message;
  if (result.results.length === 0) return "No matching memories found.";

  const lines: string[] = [`Found ${result.total} matching memories:`, ""];
  for (const item of result.results) {
    const scoreStr = typeof item.score === "number" ? ` (score: ${item.score.toFixed(3)})` : "";
    const sceneStr = item.scene_name ? ` [scene: ${item.scene_name}]` : "";
    const priorityStr = item.priority >= 0 ? ` (priority: ${item.priority})` : " (global instruction)";
    lines.push(`- **[${item.type}]**${priorityStr}${sceneStr}${scoreStr}`);
    lines.push(`  ${item.content}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function createMemorySearchTool(options: MemoryToolOptions): AnyAgentTool {
  return {
    label: "Memory Search",
    name: "tdai_memory_search",
    description: "Search through the user's long-term memories. Use this when you need to recall specific information about the user's preferences, past events, instructions, or context from previous conversations.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query describing what you want to recall about the user" },
        limit: { type: "number", description: "Maximum number of results to return (default: 5, max: 20)" },
        type: { type: "string", enum: ["persona", "episodic", "instruction"], description: "Optional filter by memory type" },
        scene: { type: "string", description: "Optional filter by scene name" },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params) {
      const startMs = Date.now();
      const p = params as Record<string, unknown>;
      const query = String(p.query ?? "");
      const limit = Math.min(Math.max(Number(p.limit) || 5, 1), 20);
      const typeFilter = typeof p.type === "string" ? p.type : undefined;
      const sceneFilter = typeof p.scene === "string" ? p.scene : undefined;

      try {
        const result = await executeMemorySearch({
          query,
          limit,
          type: typeFilter,
          scene: sceneFilter,
          vectorStore: options.vectorStore,
          embeddingService: options.embeddingService,
          logger: options.logger,
        });
        report("tool_call", {
          tool: "tdai_memory_search",
          query,
          limit,
          typeFilter,
          sceneFilter,
          resultCount: result.total,
          strategy: result.strategy,
          durationMs: Date.now() - startMs,
          success: true,
        });
        return {
          content: [{ type: "text", text: formatSearchResponse(result) }],
          details: { count: result.total, strategy: result.strategy },
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        report("tool_call", {
          tool: "tdai_memory_search",
          query,
          limit,
          typeFilter,
          sceneFilter,
          durationMs: Date.now() - startMs,
          success: false,
          error: errMsg,
        });
        return {
          content: [{ type: "text", text: `Memory search failed: ${errMsg}` }],
          details: { error: errMsg },
        };
      }
    },
  };
}

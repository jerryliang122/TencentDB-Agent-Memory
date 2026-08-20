/**
 * conversation_search tool: Agent-callable tool for searching L0 conversation records.
 */

import type { IMemoryStore, L0SearchResult } from "../core/store/types.js";
import { buildFtsQuery } from "../core/store/sqlite.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import type { Logger } from "../core/types.js";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { rrfMerge } from "../core/search/rrf.js";
import type { MemoryToolOptions } from "./common.js";

export interface ConversationSearchResultItem {
  id: string;
  session_key: string;
  role: string;
  content: string;
  score: number;
  recorded_at: string;
}

export interface ConversationSearchResult {
  results: ConversationSearchResultItem[];
  total: number;
  strategy: string;
  message?: string;
}

export async function executeConversationSearch(params: {
  query: string;
  limit: number;
  sessionKey?: string;
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
}): Promise<ConversationSearchResult> {
  const { query, limit, sessionKey: sessionFilter, vectorStore, embeddingService, logger } = params;

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

  const candidateK = sessionFilter ? limit * 4 : limit * 3;

  const [ftsItems, vecItems] = await Promise.all([
    (async (): Promise<ConversationSearchResultItem[]> => {
      if (!hasFts) return [];
      try {
        const ftsQuery = buildFtsQuery(query);
        if (!ftsQuery) return [];
        const ftsResults = await vectorStore.searchL0Fts(ftsQuery, candidateK);
        return ftsResults.map((r) => ({
          id: r.record_id,
          session_key: r.session_key,
          role: r.role,
          content: r.message_text,
          score: r.score,
          recorded_at: r.recorded_at,
        }));
      } catch {
        return [];
      }
    })(),
    (async (): Promise<ConversationSearchResultItem[]> => {
      if (!hasEmbedding) return [];
      try {
        const queryEmbedding = await embeddingService!.embed(query);
        const vecResults: L0SearchResult[] = await vectorStore.searchL0Vector(queryEmbedding, candidateK, query);
        return vecResults.map((r) => ({
          id: r.record_id,
          session_key: r.session_key,
          role: r.role,
          content: r.message_text,
          score: r.score,
          recorded_at: r.recorded_at,
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

  let results: ConversationSearchResultItem[];
  if (strategy === "hybrid") {
    results = rrfMerge(ftsItems, vecItems);
  } else {
    results = ftsOk ? ftsItems : vecItems;
  }

  if (sessionFilter) {
    results = results.filter((r) => r.session_key === sessionFilter);
  }

  const trimmed = results.slice(0, limit);
  return { results: trimmed, total: trimmed.length, strategy };
}

export function formatConversationSearchResponse(result: ConversationSearchResult): string {
  if (result.message) return result.message;
  if (result.results.length === 0) return "No matching conversation messages found.";

  const lines: string[] = [`Found ${result.total} matching message(s):`, ""];

  for (const item of result.results) {
    const scoreStr = typeof item.score === "number" ? ` (score: ${item.score.toFixed(3)})` : "";
    const dateStr = item.recorded_at ? ` [${item.recorded_at}]` : "";
    lines.push(`---`);
    lines.push(`**[${item.role}]** Session: ${item.session_key}${dateStr}${scoreStr}`);
    lines.push("");
    lines.push(item.content);
    lines.push("");
  }

  return lines.join("\n");
}

export function createConversationSearchTool(options: MemoryToolOptions): AnyAgentTool {
  return {
    label: "Conversation Search",
    name: "tdai_conversation_search",
    description: "Search through past conversation messages. Use this when you need to find specific things said in previous chats.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for conversation messages" },
        limit: { type: "number", description: "Maximum number of results (default: 5, max: 20)" },
        session_key: { type: "string", description: "Optional filter by session key" },
      },
      required: ["query"],
    },
    async execute(_toolCallId, params) {
      const query = String(params.query ?? "");
      const limit = Math.min(Math.max(Number(params.limit) || 5, 1), 20);
      const sessionKey = typeof params.session_key === "string" ? params.session_key : undefined;

      try {
        const result = await executeConversationSearch({
          query,
          limit,
          sessionKey,
          vectorStore: options.vectorStore,
          embeddingService: options.embeddingService,
          logger: options.logger,
        });
        return {
          content: [{ type: "text", text: formatConversationSearchResponse(result) }],
          details: { count: result.total, strategy: result.strategy },
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Conversation search failed: ${errMsg}` }],
          details: { error: errMsg },
        };
      }
    },
  };
}

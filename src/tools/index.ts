/**
 * Lazy-loaded tools module for memory-tencentdb plugin.
 */

import type { IMemoryStore } from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import type { Logger } from "../core/types.js";
import { createMemorySearchTool, type MemoryToolOptions } from "./memory-search.js";
import { createMemoryGetTool } from "./memory-get.js";
import { createConversationSearchTool } from "./conversation-search.js";

export { createMemorySearchTool, createMemoryGetTool, createConversationSearchTool };
export type { MemoryToolOptions };

export function createMemoryTools(options: MemoryToolOptions) {
  return {
    memorySearch: createMemorySearchTool(options),
    memoryGet: createMemoryGetTool(options),
    conversationSearch: createConversationSearchTool(options),
  };
}

export type MemoryTools = ReturnType<typeof createMemoryTools>;

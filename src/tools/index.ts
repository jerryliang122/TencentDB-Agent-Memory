/**
 * Lazy-loaded tools module for memory-tencentdb plugin.
 */

import { createMemorySearchTool } from "./memory-search.js";
import { createMemoryGetTool } from "./memory-get.js";
import { createConversationSearchTool } from "./conversation-search.js";
import type { MemoryToolOptions } from "./common.js";

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

/**
 * Shared types for memory tools.
 */

import type { IMemoryStore } from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import type { Logger } from "../core/types.js";

/**
 * Common options for memory-related tools.
 */
export interface MemoryToolOptions {
  vectorStore?: IMemoryStore;
  embeddingService?: EmbeddingService;
  logger?: Logger;
}

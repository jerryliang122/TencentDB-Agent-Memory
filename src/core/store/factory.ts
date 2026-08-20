/**
 * Store Factory — creates the SQLite storage backend and embedding service
 * based on plugin configuration.
 */

import path from "node:path";
import type { MemoryTdaiConfig } from "../../config.js";
import type { IMemoryStore, IEmbeddingService, StoreLogger } from "./types.js";
import { VectorStore } from "./sqlite.js";
import { createEmbeddingService, NoopEmbeddingService } from "./embedding.js";
import type { EmbeddingService } from "./embedding.js";
import { createBM25Encoder } from "./bm25-local.js";
import type { BM25LocalEncoder } from "./bm25-local.js";

export type { IMemoryStore, IEmbeddingService, StoreLogger, BM25LocalEncoder };

const TAG = "[memory-tdai][factory]";

export interface StoreBundle {
  store: IMemoryStore;
  embedding: IEmbeddingService;
  bm25Encoder?: BM25LocalEncoder;
  storeSnapshot: import("../../utils/manifest.js").StoreConfigSnapshot;
}

export function createStoreBundle(
  config: MemoryTdaiConfig,
  options: { dataDir: string; logger?: StoreLogger },
): StoreBundle {
  const { logger } = options;

  const bm25Encoder = createBM25Encoder(config.bm25, logger);

  let embeddingService: EmbeddingService | undefined;
  if (config.embedding.enabled && config.embedding.provider !== "local" && config.embedding.apiKey) {
    embeddingService = createEmbeddingService({
      provider: config.embedding.provider,
      baseUrl: config.embedding.baseUrl,
      apiKey: config.embedding.apiKey,
      model: config.embedding.model,
      dimensions: config.embedding.dimensions,
      sendDimensions: config.embedding.sendDimensions,
      maxInputChars: config.embedding.maxInputChars,
    }, logger);
  }

  const dims = config.embedding.dimensions;
  const dbPath = path.join(options.dataDir, "vectors.db");
  const store = new VectorStore(dbPath, dims, logger);

  logger?.debug?.(
    `${TAG} Store created: backend=sqlite, dbPath=${dbPath}, dimensions=${dims}, ` +
    `embedding=${embeddingService ? "enabled" : "disabled"}, ` +
    `bm25=${bm25Encoder ? "enabled" : "disabled"}`,
  );

  return {
    store,
    embedding: embeddingService as unknown as IEmbeddingService,
    bm25Encoder,
    storeSnapshot: {
      type: "sqlite",
      sqlitePath: path.relative(options.dataDir, dbPath),
    },
  };
}

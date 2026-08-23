import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "./sqlite.js";

describe("VectorStore L0 pagination", () => {
  let tmpDir: string;
  let store: VectorStore | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-sqlite-pagination-"));
  });

  afterEach(async () => {
    store?.close();
    store = undefined;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns oldest-first pages and preserves every row sharing the boundary timestamp", () => {
    store = new VectorStore(path.join(tmpDir, "vectors.db"), 0);
    store.init();
    expect(store.isDegraded()).toBe(false);

    const sessionKey = "agent:test:sqlite";
    const baseMs = Date.UTC(2026, 0, 1);
    const rows = Array.from({ length: 60 }, (_, index) => {
      const recordedOffset = index < 49 ? index : index <= 51 ? 49 : index - 2;
      return {
        id: `msg-${String(index).padStart(3, "0")}`,
        sessionKey,
        sessionId: "conversation-1",
        role: index % 2 === 0 ? "user" : "assistant",
        messageText: `sqlite pagination regression message ${index}`,
        recordedAt: new Date(baseMs + recordedOffset * 1_000).toISOString(),
        timestamp: baseMs + index,
      };
    });

    for (const row of rows.toReversed()) {
      expect(store.upsertL0(row, undefined)).toBe(true);
    }

    const firstPage = store.queryL0ForL1(sessionKey, undefined, 50);
    expect(firstPage).toHaveLength(52);
    expect(firstPage.map((row) => row.record_id)).toEqual(
      rows.slice(0, 52).map((row) => row.id),
    );

    const cursor = Math.max(...firstPage.map((row) => Date.parse(row.recorded_at)));
    expect(cursor).toBe(baseMs + 49_000);

    const secondPage = store.queryL0ForL1(sessionKey, cursor, 50);
    expect(secondPage).toHaveLength(8);
    expect(secondPage.map((row) => row.record_id)).toEqual(
      rows.slice(52).map((row) => row.id),
    );
  });
});

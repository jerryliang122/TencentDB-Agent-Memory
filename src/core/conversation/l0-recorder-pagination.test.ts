import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readConversationMessagesGroupedBySessionId } from "./l0-recorder.js";

describe("readConversationMessagesGroupedBySessionId pagination", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l0-pagination-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("drains the oldest page without splitting a recordedAt boundary cohort", async () => {
    const sessionKey = "agent:test:session";
    const baseMs = Date.UTC(2026, 0, 1);
    const rows = Array.from({ length: 60 }, (_, index) => {
      // Rows 49-51 share the timestamp containing the nominal 50th row.
      const recordedOffset = index < 49 ? index : index <= 51 ? 49 : index - 2;
      return {
        sessionKey,
        sessionId: "conversation-1",
        recordedAt: new Date(baseMs + recordedOffset * 1_000).toISOString(),
        id: `msg-${String(index).padStart(3, "0")}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `pagination regression message ${index}`,
        timestamp: baseMs + index,
      };
    });

    const conversationsDir = path.join(tmpDir, "conversations");
    await fs.mkdir(conversationsDir, { recursive: true });
    // Reverse physical file order to verify ordering comes from recordedAt.
    await fs.writeFile(
      path.join(conversationsDir, "2026-01-01.jsonl"),
      rows.toReversed().map((row) => JSON.stringify(row)).join("\n") + "\n",
      "utf-8",
    );

    const firstPage = await readConversationMessagesGroupedBySessionId(
      sessionKey,
      tmpDir,
      undefined,
      undefined,
      50,
    );
    const firstMessages = firstPage.flatMap((group) => group.messages);

    expect(firstMessages).toHaveLength(52);
    expect(firstMessages.map((message) => message.id)).toEqual(
      rows.slice(0, 52).map((row) => row.id),
    );

    const cursor = Math.max(...firstMessages.map((message) => message.recordedAtMs));
    expect(cursor).toBe(baseMs + 49_000);

    const secondPage = await readConversationMessagesGroupedBySessionId(
      sessionKey,
      tmpDir,
      cursor,
      undefined,
      50,
    );
    const secondMessages = secondPage.flatMap((group) => group.messages);

    expect(secondMessages).toHaveLength(8);
    expect(secondMessages.map((message) => message.id)).toEqual(
      rows.slice(52).map((row) => row.id),
    );
  });

  it("derives stable cursor fields for legacy rows missing recordedAt, timestamp, and id", async () => {
    const sessionKey = "agent:test:legacy";
    const conversationsDir = path.join(tmpDir, "conversations");
    await fs.mkdir(conversationsDir, { recursive: true });
    await fs.writeFile(
      path.join(conversationsDir, "2026-01-02.jsonl"),
      JSON.stringify({
        sessionKey,
        sessionId: "legacy-conversation",
        role: "user",
        content: "legacy row with deterministic fallback fields",
      }) + "\n",
      "utf-8",
    );

    const firstRead = await readConversationMessagesGroupedBySessionId(sessionKey, tmpDir);
    const repeatedRead = await readConversationMessagesGroupedBySessionId(sessionKey, tmpDir);
    expect(repeatedRead).toEqual(firstRead);

    const message = firstRead[0].messages[0];
    expect(message.id).toMatch(/^msg_legacy_[0-9a-f]{16}$/);
    expect(message.recordedAtMs).toBe(Date.UTC(2026, 0, 2));

    const afterCursor = await readConversationMessagesGroupedBySessionId(
      sessionKey,
      tmpDir,
      message.recordedAtMs,
    );
    expect(afterCursor).toEqual([]);
  });

  it("fails closed on malformed JSONL instead of returning newer rows", async () => {
    const sessionKey = "agent:test:malformed";
    const conversationsDir = path.join(tmpDir, "conversations");
    await fs.mkdir(conversationsDir, { recursive: true });
    const validNewerRow = JSON.stringify({
      sessionKey,
      sessionId: "conversation-1",
      recordedAt: "2026-01-03T00:00:01.000Z",
      id: "msg-newer",
      role: "user",
      content: "newer valid row must not advance past a malformed predecessor",
      timestamp: Date.UTC(2026, 0, 3, 0, 0, 1),
    });
    await fs.writeFile(
      path.join(conversationsDir, "2026-01-03.jsonl"),
      `{\"sessionKey\":\"${sessionKey}\"\n${validNewerRow}\n`,
      "utf-8",
    );

    await expect(
      readConversationMessagesGroupedBySessionId(sessionKey, tmpDir),
    ).rejects.toThrow("Malformed JSONL line");
  });
});

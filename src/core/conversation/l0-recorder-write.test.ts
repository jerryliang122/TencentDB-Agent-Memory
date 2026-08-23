import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { recordConversation } from "./l0-recorder.js";

describe("recordConversation persistence failures", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupPaths.splice(0).map((target) => fs.rm(target, { recursive: true, force: true })));
  });

  it("rejects when the L0 file cannot be written so callers do not advance their checkpoint", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tdai-l0-write-"));
    cleanupPaths.push(tmpDir);

    const invalidBaseDir = path.join(tmpDir, "not-a-directory");
    await fs.writeFile(invalidBaseDir, "occupied", "utf-8");
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    await expect(recordConversation({
      sessionKey: "agent:test",
      rawMessages: [{
        role: "user",
        content: "Please remember that I prefer concise TypeScript examples.",
        timestamp: 1_700_000_000_000,
      }],
      baseDir: invalidBaseDir,
      logger,
    })).rejects.toThrow();

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Failed to write L0 file"));
  });
});

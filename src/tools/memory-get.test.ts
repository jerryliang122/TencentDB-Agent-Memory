import { describe, expect, it } from "vitest";

import { executeMemoryGet, formatMemoryGetResponse, sanitizeToolError, createMemoryGetTool } from "./memory-get.js";
import type { IMemoryStore, L1RecordRow } from "../core/store/types.js";

const TAG = "[memory-tdai][tdai_memory_get]";

// ── Stub factory ──────────────────────────────────────────────────────────
// Minimal IMemoryStore stub: only `getL1ById` is exercised here. Other
// methods are left as `never`-throwing stubs so the stub satisfies the
// interface without forcing us to implement the entire store surface.

function makeStubStore(opts: {
  getL1ById?: (id: string) => L1RecordRow | null | Promise<L1RecordRow | null>;
  throws?: Error;
}): IMemoryStore {
  const store = {
    getL1ById: opts.throws
      ? () => { throw opts.throws; }
      : (opts.getL1ById ?? (() => null)),
  } as Partial<IMemoryStore>;

  // Fill the rest of the interface with throwing stubs so any accidental
  // call surfaces clearly in test output.
  const proxy = new Proxy(store as IMemoryStore, {
    get(target, prop: string) {
      if (prop in target) {
        return (target as unknown as Record<string, unknown>)[prop];
      }
      throw new Error(`stub store: unexpected call to IMemoryStore.${prop}`);
    },
  });
  return proxy;
}

const sampleRow: L1RecordRow = {
  record_id: "m_1785515129486_dee4cb6c",
  content: "用户（Jerry）在 2026-07-07 部署 gemma-4-12b 模型到腾讯云 GPU 的完整经历…",
  type: "episodic",
  priority: 80,
  scene_name: "我帮Jerry完成KOOK官方语音API调研",
  session_key: "agent:main:qqbot:direct:abc",
  session_id: "sess-1",
  timestamp_str: "2026-07-07T08:00:00.000Z",
  timestamp_start: "2026-07-07T08:00:00.000Z",
  timestamp_end: "2026-07-10T12:18:00.000Z",
  created_time: "2026-07-07T08:05:00.000Z",
  updated_time: "2026-07-10T12:20:00.000Z",
  metadata_json: '{"activity_start_time":"2026-07-07T08:00:00.000Z","activity_end_time":"2026-07-10T12:18:00.000Z"}',
};

describe("executeMemoryGet", () => {
  it("returns found=true with full record when store hits", async () => {
    const store = makeStubStore({
      getL1ById: (id) => (id === sampleRow.record_id ? sampleRow : null),
    });

    const result = await executeMemoryGet({
      recordId: sampleRow.record_id,
      vectorStore: store,
    });

    expect(result.found).toBe(true);
    expect(result.record).toBeDefined();
    expect(result.record?.record_id).toBe(sampleRow.record_id);
    expect(result.record?.content).toBe(sampleRow.content);
    expect(result.record?.type).toBe("episodic");
    expect(result.record?.scene_name).toBe(sampleRow.scene_name);
    expect(result.record?.priority).toBe(80);
  });

  it("returns found=false when record was deleted (store returns null)", async () => {
    const store = makeStubStore({ getL1ById: () => null });

    const result = await executeMemoryGet({
      recordId: "m_deleted",
      vectorStore: store,
    });

    expect(result.found).toBe(false);
    expect(result.record).toBeUndefined();
  });

  it("returns found=false without calling store when recordId is empty", async () => {
    let called = false;
    const store = makeStubStore({
      getL1ById: () => { called = true; return null; },
    });

    const result = await executeMemoryGet({ recordId: "", vectorStore: store });

    expect(result.found).toBe(false);
    expect(called).toBe(false);
  });

  it("returns found=false without calling store when recordId is whitespace", async () => {
    let called = false;
    const store = makeStubStore({
      getL1ById: () => { called = true; return null; },
    });

    const result = await executeMemoryGet({ recordId: "   ", vectorStore: store });

    expect(result.found).toBe(false);
    expect(called).toBe(false);
  });

  it("returns found=false when vectorStore is undefined", async () => {
    const result = await executeMemoryGet({
      recordId: sampleRow.record_id,
      vectorStore: undefined,
    });

    expect(result.found).toBe(false);
  });

  it("returns found=false (does not throw) when store throws", async () => {
    const store = makeStubStore({ throws: new Error("sqlite: disk I/O error") });

    const result = await executeMemoryGet({
      recordId: sampleRow.record_id,
      vectorStore: store,
    });

    expect(result.found).toBe(false);
    expect(result.record).toBeUndefined();
  });

  it("awaits async getL1ById implementations", async () => {
    const store = makeStubStore({
      getL1ById: async (id) => (id === sampleRow.record_id ? sampleRow : null),
    });

    const result = await executeMemoryGet({
      recordId: sampleRow.record_id,
      vectorStore: store,
    });

    expect(result.found).toBe(true);
    expect(result.record?.record_id).toBe(sampleRow.record_id);
  });
});

describe("formatMemoryGetResponse", () => {
  it("formats a hit with full content + metadata fields", () => {
    const result = formatMemoryGetResponse({
      found: true,
      record: sampleRow,
    });

    expect(result).toContain(sampleRow.content);
    expect(result).toContain("[episodic]");
    expect(result).toContain(`scene: ${sampleRow.scene_name}`);
    expect(result).toContain("priority: 80");
    expect(result).toContain(sampleRow.record_id);
    // Activity time range should be rendered from metadata_json (human-readable)
    expect(result).toContain("活动时间");
    expect(result).toContain("2026-07-07T08:00:00.000Z");
  });

  it("formats a miss with friendly not-found message containing the record_id", () => {
    const result = formatMemoryGetResponse({
      found: false,
      record: undefined,
    });

    // The caller doesn't pass record_id in the miss case, so the formatter
    // must accept an optional record_id hint for context.
    expect(result).toMatch(/not found/i);
  });

  it("formats a miss with explicit record_id hint when provided", () => {
    const result = formatMemoryGetResponse({
      found: false,
      record: undefined,
      recordIdHint: "m_deleted_xyz",
    });

    expect(result).toContain("m_deleted_xyz");
    expect(result).toMatch(/not found/i);
  });
});

describe("sanitizeToolError", () => {
  // Security contract: raw error messages from store/runtime internals
  // (SQL errors, file paths, stack traces, etc.) must NEVER reach the LLM
  // agent. The agent only sees a generic user-facing message + generic code;
  // the full original error is preserved separately for logs/telemetry.

  const SENSITIVE_PATTERNS = [
    /sqlite/i,
    /SQLITE_/,
    /disk I\/O error/i,
    /\/tmp\//,             // file path leak
    /\/root\//,
    /ENOENT/,
    /stack trace/i,
  ];

  function assertNoLeak(got: { userMessage: string; errorCode: string }) {
    for (const re of SENSITIVE_PATTERNS) {
      expect(got.userMessage).not.toMatch(re);
      expect(got.errorCode).not.toMatch(re);
    }
  }

  it("returns generic message for Error instance with SQL error details", () => {
    const err = new Error("sqlite: disk I/O error at /root/.openclaw/memory-tdai/vectors.db");
    const result = sanitizeToolError(err);

    expect(result.userMessage).toMatch(/Memory get failed/i);
    expect(result.userMessage).toMatch(/tdai_memory_search/i); // suggests fallback
    expect(result.errorCode).toBe("internal_error");
    // Internal detail preserved for logs, NOT for LLM
    expect(result.internalError).toContain("sqlite: disk I/O error");
    assertNoLeak(result);
  });

  it("returns generic message for string error", () => {
    const err = "ENOENT: no such file or directory, open '/root/.openclaw/vectors.db'";
    const result = sanitizeToolError(err);

    expect(result.errorCode).toBe("internal_error");
    assertNoLeak(result);
    // Original preserved internally
    expect(result.internalError).toContain("ENOENT");
  });

  it("returns generic message for non-Error thrown object", () => {
    const err = { code: "SQLITE_BUSY", message: "database is locked", stack: "..." };
    const result = sanitizeToolError(err);

    expect(result.errorCode).toBe("internal_error");
    assertNoLeak(result);
  });

  it("preserves the original error verbatim in internalError for log/telemetry use", () => {
    const original = "some weird internal detail: foo=42, path=/etc/secrets";
    const result = sanitizeToolError(new Error(original));

    expect(result.internalError).toBe(original);
  });

  it("handles null/undefined thrown values without throwing itself", () => {
    expect(() => sanitizeToolError(null)).not.toThrow();
    expect(() => sanitizeToolError(undefined)).not.toThrow();

    const r1 = sanitizeToolError(null);
    const r2 = sanitizeToolError(undefined);
    expect(r1.errorCode).toBe("internal_error");
    expect(r2.errorCode).toBe("internal_error");
    assertNoLeak(r1);
    assertNoLeak(r2);
  });
});

describe("createMemoryGetTool failure-path details contract", () => {
  // The tool result `details` object is visible to the LLM agent. On internal
  // failures it must expose only the generic errorCode — never the raw
  // internal error text (SQL messages, file paths), which is for logs only.
  it("returns only errorCode in details when execute throws", async () => {
    // Accessing options.vectorStore throws → the tool-level catch fires.
    const tool = createMemoryGetTool({
      get vectorStore(): never {
        throw new Error("sqlite: disk I/O error at /root/.openclaw/memory-tdai/vectors.db");
      },
    } as never);
    const result = await tool.execute("call-1", { record_id: "m_x" });

    expect(result.details).toEqual({ errorCode: "internal_error" });
    expect(JSON.stringify(result.details)).not.toMatch(/sqlite|disk I\/O|\/root\//i);
    expect((result.content[0] as { type: "text"; text: string }).text).toMatch(/Memory get failed/i);
  });

  it("exposes found flag in details on success and miss", async () => {
    const hitStore = makeStubStore({ getL1ById: () => sampleRow });
    const missStore = makeStubStore({ getL1ById: () => null });

    const hit = await createMemoryGetTool({ vectorStore: hitStore } as never).execute("c1", { record_id: sampleRow.record_id });
    expect(hit.details).toEqual({ found: true });

    const miss = await createMemoryGetTool({ vectorStore: missStore } as never).execute("c2", { record_id: "m_none" });
    expect(miss.details).toEqual({ found: false });
  });
});

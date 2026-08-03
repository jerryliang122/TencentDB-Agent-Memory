import { describe, expect, it } from "vitest";

import { executeMemoryGet, formatMemoryGetResponse } from "./memory-get.js";
import type { IMemoryStore, L1RecordRow } from "../store/types.js";

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
        return (target as Record<string, unknown>)[prop];
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

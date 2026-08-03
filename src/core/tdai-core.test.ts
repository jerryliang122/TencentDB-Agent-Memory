import { describe, expect, it } from "vitest";

import { TdaiCore } from "./tdai-core.js";
import type { HostAdapter, Logger, RuntimeContext, LLMRunnerFactory } from "./types.js";
import type { IMemoryStore, L1RecordRow } from "./store/types.js";
import type { MemoryTdaiConfig } from "../config.js";

// ── Stubs ──────────────────────────────────────────────────────────────────

const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const stubRuntimeContext: RuntimeContext = {
  userId: "test",
  sessionId: "sess-test",
  sessionKey: "agent:test:session",
  platform: "test",
  workspaceDir: "/tmp/test-workspace",
  dataDir: "/tmp/test-data-dir",
};

const stubHostAdapter: HostAdapter = {
  hostType: "standalone",
  getRuntimeContext: () => stubRuntimeContext,
  getLogger: () => noopLogger,
  getLLMRunnerFactory: (): LLMRunnerFactory => ({
    createRunner: () => {
      throw new Error("LLM runner not used in this test");
    },
  }),
};

const stubConfig = {
  extraction: { enabled: false },
} as unknown as MemoryTdaiConfig;

// Minimal stub store: only `getL1ById` is exercised here. The rest of the
// IMemoryStore surface is proxied to a throwing stub so accidental calls
// surface loudly.
function makeStubStore(opts: {
  getL1ById?: (id: string) => L1RecordRow | null;
}): IMemoryStore {
  const store = {
    getL1ById: opts.getL1ById ?? (() => null),
  } as Partial<IMemoryStore>;
  return new Proxy(store as IMemoryStore, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop];
      throw new Error(`stub store: unexpected call to IMemoryStore.${prop}`);
    },
  });
}

const sampleRow: L1RecordRow = {
  record_id: "m_test_sample",
  content: "用户（Test）在 2026-08-03 测试 getMemory 路径",
  type: "episodic",
  priority: 70,
  scene_name: "测试场景",
  session_key: "agent:test:session",
  session_id: "sess-test",
  timestamp_str: "2026-08-03T00:00:00.000Z",
  timestamp_start: "2026-08-03T00:00:00.000Z",
  timestamp_end: "2026-08-03T01:00:00.000Z",
  created_time: "2026-08-03T00:00:00.000Z",
  updated_time: "2026-08-03T00:00:00.000Z",
  metadata_json: '{"activity_start_time":"2026-08-03T00:00:00.000Z"}',
};

// Helper: construct a TdaiCore and inject a stub vectorStore without running
// the full async initialize() path (which would try to open a real SQLite file).
function makeCoreWithStore(store: IMemoryStore | undefined): TdaiCore {
  const core = new TdaiCore({ hostAdapter: stubHostAdapter, config: stubConfig });
  // Inject the store directly — bypasses initStores(). storeReady stays
  // undefined which the `await this.storeReady?.catch(() => {})` line tolerates.
  (core as unknown as { vectorStore?: IMemoryStore }).vectorStore = store;
  return core;
}

describe("TdaiCore.getMemory", () => {
  it("returns found=true with formatted text when store has the record", async () => {
    const store = makeStubStore({
      getL1ById: (id) => (id === sampleRow.record_id ? sampleRow : null),
    });
    const core = makeCoreWithStore(store);

    const result = await core.getMemory(sampleRow.record_id);

    expect(result.found).toBe(true);
    expect(result.text).toContain(sampleRow.content);
    expect(result.text).toContain(`[id: ${sampleRow.record_id}]`);
  });

  it("returns found=false when record was deleted", async () => {
    const store = makeStubStore({ getL1ById: () => null });
    const core = makeCoreWithStore(store);

    const result = await core.getMemory("m_deleted");

    expect(result.found).toBe(false);
    expect(result.text).toMatch(/not found/i);
    expect(result.text).toContain("m_deleted");
  });

  it("returns found=false when recordId is empty", async () => {
    const store = makeStubStore({
      getL1ById: () => { throw new Error("should not be called"); },
    });
    const core = makeCoreWithStore(store);

    const result = await core.getMemory("");

    expect(result.found).toBe(false);
  });

  it("returns found=false when vectorStore is unavailable (init failed)", async () => {
    const core = makeCoreWithStore(undefined);

    const result = await core.getMemory(sampleRow.record_id);

    expect(result.found).toBe(false);
    expect(result.text).toMatch(/not found|unavailable/i);
  });

  it("returns found=false (does not throw) when store throws", async () => {
    const throwingStore = makeStubStore({
      getL1ById: () => { throw new Error("disk I/O error"); },
    });
    const core = makeCoreWithStore(throwingStore);

    const result = await core.getMemory(sampleRow.record_id);

    expect(result.found).toBe(false);
  });
});

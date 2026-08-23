import { describe, it, expect, vi, beforeEach } from "vitest";
import { createOpenAICompatibleRunner } from "./openai-runner.js";

const okResponse = (content = "ok") => ({
  ok: true,
  status: 200,
  json: async () => ({ choices: [{ message: { role: "assistant", content } }] }),
  text: async () => "",
});

const errResponse = (status: number, body: string) => ({
  ok: false,
  status,
  json: async () => ({ choices: [] }),
  text: async () => body,
});

function makeRunner(overrides: Record<string, unknown> = {}) {
  return createOpenAICompatibleRunner({
    baseUrl: "http://llm.example/v1",
    apiKey: "test-key",
    model: "test-model",
    retryBaseDelayMs: 1,
    ...overrides,
  });
}

describe("createOpenAICompatibleRunner", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse()));
  });

  it("normalizes a trailing slash in baseUrl", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const runner = makeRunner({ baseUrl: "http://llm.example/v1/" });
    await runner.run({ prompt: "p", taskId: "test-task" });

    expect(fetchMock.mock.calls[0][0]).toBe("http://llm.example/v1/chat/completions");
  });

  it("sends Authorization header and max_tokens body", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => okResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);

    const runner = makeRunner({ maxTokens: 123 });
    await runner.run({ prompt: "hello", systemPrompt: "sys", taskId: "test-task" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://llm.example/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const body = JSON.parse(init.body as string);
    expect(body.max_tokens).toBe(123);
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
  });

  it("retries transient 5xx failures and succeeds on a later attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(502, "bad gateway"))
      .mockResolvedValueOnce(errResponse(503, "unavailable"))
      .mockResolvedValueOnce(okResponse("third try"));
    vi.stubGlobal("fetch", fetchMock);

    const out = await makeRunner().run({ prompt: "p", taskId: "test-task" });

    expect(out).toBe("third try");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries network errors (fetch rejection)", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(okResponse("recovered"));
    vi.stubGlobal("fetch", fetchMock);

    const out = await makeRunner().run({ prompt: "p", taskId: "test-task" });

    expect(out).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 429 rate-limit responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(errResponse(429, "rate limited"))
      .mockResolvedValueOnce(okResponse("after limit"));
    vi.stubGlobal("fetch", fetchMock);

    const out = await makeRunner().run({ prompt: "p", taskId: "test-task" });

    expect(out).toBe("after limit");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after 2 retries (3 attempts total)", async () => {
    const fetchMock = vi.fn(async () => errResponse(500, "down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeRunner().run({ prompt: "p", taskId: "test-task" })).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry non-transient 4xx client errors", async () => {
    const fetchMock = vi.fn(async () => errResponse(401, "invalid api key"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeRunner().run({ prompt: "p", taskId: "test-task" })).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("honors maxRetries: 0 for a single attempt", async () => {
    const fetchMock = vi.fn(async () => errResponse(500, "down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(makeRunner({ maxRetries: 0 }).run({ prompt: "p", taskId: "test-task" })).rejects.toThrow(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

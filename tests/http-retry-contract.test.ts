import { afterEach, describe, expect, it, vi } from "vitest";
import { executeHttpTool } from "../src/tools/http-tool.js";

const secrets = { async get() { return "secret"; } };
afterEach(() => vi.unstubAllGlobals());

describe("HTTP tool resilience contract", () => {
  it("retries retryable upstream failures for idempotent requests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHttpTool({
      method: "GET",
      url: "https://api.example.com/status",
      retry: { maxAttempts: 2, baseDelayMs: 25, maxDelayMs: 25 },
    }, {}, secrets);

    expect(result.ok).toBe(true);
    expect(result.metadata?.attempts).toBe(2);
  });

  it("does not retry side effects without an idempotency header", async () => {
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await executeHttpTool({
      method: "POST",
      url: "https://api.example.com/pay",
      retry: { maxAttempts: 3 },
    }, {}, secrets, "event-1");

    expect(result.ok).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

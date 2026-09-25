import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpToolExecutor } from "../src/tools/http-tool.js";
import type { SecretProvider } from "../src/ports/secrets.js";

const secrets: SecretProvider = {
  async get(ref) { return `secret:${ref.key}`; },
};

afterEach(() => vi.unstubAllGlobals());

describe("HTTP tool safety", () => {
  it("rejects dynamic origins before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const executor = new HttpToolExecutor(secrets);
    const result = await executor.execute({ method: "GET", url: "https://{{host}}/x" }, { host: "evil.example" });
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects hosts outside the allowlist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const executor = new HttpToolExecutor(secrets);
    const result = await executor.execute(
      { method: "GET", url: "https://api.example.com/x", allowedHosts: ["core.example.com"] },
      {},
    );
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves portable secret refs into headers", async () => {
    const fetchMock = vi.fn(async (_url, init) => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({ authorization: (init as RequestInit).headers }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    const executor = new HttpToolExecutor(secrets);

    const result = await executor.execute({
      method: "GET",
      url: "https://api.example.com/x",
      secretHeaders: { Authorization: { key: "core.authorization" } },
    }, {});

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers.Authorization).toBe("secret:core.authorization");
  });
});

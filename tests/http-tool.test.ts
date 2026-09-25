import { afterEach, describe, expect, it, vi } from "vitest";
import { executeHttpTool } from "../src/tools/http-tool.js";

const secrets = { get: async () => "unused" };

afterEach(() => vi.unstubAllGlobals());

describe("HTTP tool safety", () => {
  it("rejects dynamic origins before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeHttpTool({ method: "GET", url: "https://{{host}}/x" }, { host: "evil.example" }, secrets);
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects hosts outside the allowlist", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await executeHttpTool(
      { method: "GET", url: "https://api.example.com/x", allowedHosts: ["core.example.com"] },
      {},
      secrets,
    );
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModelProvider } from "../src/providers/openai-compatible.js";
import type { SecretProvider } from "../src/ports/secrets.js";

const secrets: SecretProvider = {
  async get(ref) {
    expect(ref.key).toBe("models/openai");
    return "test-key";
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("OpenAICompatibleModelProvider", () => {
  it("translates portable tools and tool calls", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("gpt-test");
      expect(body.tools[0].function.name).toBe("lookup");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: null,
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: "{\"id\":\"123\"}" },
            }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 4 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleModelProvider(secrets);
    const result = await provider.generate({
      config: {
        provider: "openai",
        model: "gpt-test",
        apiKeySecret: { key: "models/openai" },
      },
      system: "system",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      tools: [{
        name: "lookup",
        description: "lookup",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      }],
    });

    expect(result.content).toEqual([{
      type: "tool_call",
      id: "call-1",
      name: "lookup",
      input: { id: "123" },
    }]);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("rejects malformed tool arguments", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            id: "call-1",
            function: { name: "lookup", arguments: "not-json" },
          }],
        },
      }],
    }), { status: 200 })));

    const provider = new OpenAICompatibleModelProvider(secrets);
    await expect(provider.generate({
      config: {
        provider: "openai",
        model: "gpt-test",
        apiKeySecret: { key: "models/openai" },
      },
      system: "system",
      messages: [],
    })).rejects.toThrow(/invalid JSON arguments/);
  });
});

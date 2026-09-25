import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleModelProvider } from "../src/adapters/models/openai-compatible.js";
import type { SecretProvider } from "../src/ports/secrets.js";

const secrets: SecretProvider = {
  async get(reference) {
    const key = typeof reference === "string" ? reference : reference.key;
    expect(key).toBe("models/openai/api-key");
    return "test-key";
  },
};

afterEach(() => vi.unstubAllGlobals());

describe("OpenAICompatibleModelProvider", () => {
  it("maps portable tools and tool calls", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("gpt-test");
      expect(body.tools[0].function.name).toBe("lookup");
      expect(body.max_tokens).toBe(500);
      expect(body.temperature).toBe(0.1);
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
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleModelProvider(secrets);
    const response = await provider.generate({
      model: {
        provider: "openai",
        model: "gpt-test",
        apiKeySecret: { key: "models/openai/api-key" },
        maxTokens: 500,
        temperature: 0.1,
      },
      system: "system",
      messages: [{ role: "user", content: [{ type: "text", text: "hola" }] }],
      tools: [{
        name: "lookup",
        description: "Lookup",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
      }],
    });

    expect(response.toolCalls).toEqual([{
      id: "call-1",
      name: "lookup",
      input: { id: "123" },
    }]);
    expect(response.message.content).toEqual([{
      type: "tool_call",
      id: "call-1",
      name: "lookup",
      input: { id: "123" },
    }]);
  });

  it("maps tool results back to provider tool messages", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.messages).toEqual([
        { role: "system", content: "system" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: "{\"id\":\"123\"}" },
          }],
        },
        {
          role: "tool",
          tool_call_id: "call-1",
          content: "{\"ok\":true,\"data\":{\"name\":\"Ada\"}}",
        },
      ]);

      return new Response(JSON.stringify({
        choices: [{ message: { content: "Hola Ada" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAICompatibleModelProvider(secrets);
    const response = await provider.generate({
      model: {
        provider: "openai",
        model: "gpt-test",
        apiKeySecret: { key: "models/openai/api-key" },
      },
      system: "system",
      messages: [
        {
          role: "assistant",
          content: [{
            type: "tool_call",
            id: "call-1",
            name: "lookup",
            input: { id: "123" },
          }],
        },
        {
          role: "user",
          content: [{
            type: "tool_result",
            id: "call-1",
            result: { ok: true, data: { name: "Ada" } },
          }],
        },
      ],
      tools: [],
    });

    expect(response.text).toBe("Hola Ada");
  });

  it("rejects invalid JSON tool arguments", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            id: "call-1",
            function: { name: "lookup", arguments: "not-json" },
          }],
        },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const provider = new OpenAICompatibleModelProvider(secrets);
    await expect(provider.generate({
      model: {
        provider: "openai",
        model: "gpt-test",
        apiKeySecret: { key: "models/openai/api-key" },
      },
      system: "system",
      messages: [],
      tools: [],
    })).rejects.toThrow(/invalid JSON arguments/);
  });
});

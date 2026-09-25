import { describe, expect, it } from "vitest";
import type { ModelProvider } from "../src/ports/model.js";

function providerContract(name: string, provider: ModelProvider): void {
  describe(`${name} ModelProvider contract`, () => {
    it("exposes stable identity and capability flags", () => {
      expect(provider.id.length).toBeGreaterThan(0);
      expect(typeof provider.capabilities.toolCalling).toBe("boolean");
      expect(typeof provider.capabilities.streaming).toBe("boolean");
    });

    it("returns the portable response envelope", async () => {
      const response = await provider.generate({
        model: { provider: provider.id, model: "contract-model" },
        system: "contract",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        tools: [],
      });
      expect(response.message.role).toBe("assistant");
      expect(Array.isArray(response.message.content)).toBe(true);
      expect(Array.isArray(response.toolCalls)).toBe(true);
      expect(typeof response.text).toBe("string");
    });
  });
}

providerContract("fake", {
  id: "fake",
  capabilities: {
    toolCalling: true,
    parallelToolCalls: false,
    structuredOutput: false,
    vision: false,
    documents: false,
    streaming: false,
  },
  async generate() {
    return {
      message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      text: "ok",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      finishReason: "stop",
    };
  },
});

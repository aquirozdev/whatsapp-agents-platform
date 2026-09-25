import { describe, expect, it } from "vitest";
import type { ModelProvider } from "../src/ports/model.js";
import { ModelProviderRegistry } from "../src/ports/model.js";

const fake: ModelProvider = {
  id: "fake",
  capabilities: {
    toolCalling: true,
    parallelToolCalls: false,
    structuredOutput: false,
    vision: false,
    documents: false,
    streaming: false,
  },
  async generate(request) {
    return {
      message: { role: "assistant", content: [{ type: "text", text: `model:${request.model.model}` }] },
      text: `model:${request.model.model}`,
      toolCalls: [],
    };
  },
};

describe("ModelProviderRegistry", () => {
  it("resolves providers without coupling the runtime to a vendor", async () => {
    const registry = new ModelProviderRegistry([fake]);
    const provider = registry.get("fake");
    const response = await provider.generate({
      model: { provider: "fake", model: "m1" },
      system: "test",
      messages: [],
      tools: [],
    });
    expect(response.text).toBe("model:m1");
  });

  it("rejects duplicate providers", () => {
    expect(() => new ModelProviderRegistry([fake, fake])).toThrow(/already registered/);
  });
});

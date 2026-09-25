import { describe, expect, it } from "vitest";
import { AgentRuntime } from "../src/core/agent-runtime.js";
import type { AgentConfig, ConversationState, InboundEnvelope, ToolBinding, ToolExecutionResult } from "../src/core/types.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/ports/model.js";
import type { PlatformStorePort } from "../src/ports/store.js";
import type { ToolExecutor } from "../src/ports/tools.js";
import { ModelRegistry } from "../src/providers/model-registry.js";

class FakeModel implements ModelProvider {
  readonly capabilities = {
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    documents: false,
    streaming: false,
  } as const;
  calls: ModelRequest[] = [];

  constructor(readonly id: string, private readonly responses: ModelResponse[]) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const response = this.responses.shift();
    if (!response) throw new Error("No fake model response.");
    return response;
  }
}

class FakeTools implements ToolExecutor {
  calls: string[] = [];
  async execute(binding: ToolBinding): Promise<ToolExecutionResult> {
    this.calls.push(binding.name);
    return { ok: true, data: { value: "42" } };
  }
}

class FakeStore {
  conversation: ConversationState = {
    tenantId: "t1",
    channel: "web",
    conversationId: "u1",
    userId: "u1",
    mode: "ai",
    messages: [],
    verification: { level: "none" },
    revision: 0,
    updatedAt: new Date().toISOString(),
  };
  audits: unknown[] = [];

  async getConversation() { return this.conversation; }
  async saveConversation(state: ConversationState) { state.revision = (state.revision ?? 0) + 1; this.conversation = state; }
  async commitTurn(state: ConversationState) { state.revision = (state.revision ?? 0) + 1; this.conversation = state; }
  async audit(...args: unknown[]) { this.audits.push(args); }
  async hasConsent() { return true; }
  async getTenantVersion() { return undefined; }
}

function tenant(provider: string): AgentConfig {
  return {
    tenantId: "t1",
    displayName: "Tenant",
    enabled: true,
    systemPrompt: "Be helpful",
    model: { provider, model: "test-model" },
    tools: [{
      name: "lookup",
      kind: "http",
      exposure: "agent",
      description: "Lookup data",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      http: { method: "GET", url: "https://example.com" },
    }],
  };
}

const inbound: InboundEnvelope = {
  tenantId: "t1",
  channel: "web",
  conversationId: "u1",
  userId: "u1",
  text: "hola",
  externalMessageId: "m1",
  receivedAt: new Date().toISOString(),
};

describe("model portability", () => {
  it("runs the same agent runtime with any registered model provider", async () => {
    for (const providerId of ["provider-a", "provider-b"]) {
      const model = new FakeModel(providerId, [{ content: [{ type: "text", text: `reply-${providerId}` }] }]);
      const store = new FakeStore();
      const runtime = new AgentRuntime(
        store as unknown as PlatformStorePort,
        new ModelRegistry([model]),
        new FakeTools(),
      );

      const result = await runtime.execute(tenant(providerId), inbound);
      expect(result.text).toBe(`reply-${providerId}`);
      expect(model.calls).toHaveLength(1);
    }
  });

  it("executes tool calls through the tool port, not the model adapter", async () => {
    const model = new FakeModel("provider-a", [
      { content: [{ type: "tool_call", id: "call-1", name: "lookup", input: {} }] },
      { content: [{ type: "text", text: "resultado" }] },
    ]);
    const tools = new FakeTools();
    const runtime = new AgentRuntime(
      new FakeStore() as unknown as PlatformStorePort,
      new ModelRegistry([model]),
      tools,
    );

    const result = await runtime.execute(tenant("provider-a"), inbound);
    expect(result.text).toBe("resultado");
    expect(tools.calls).toEqual(["lookup"]);
    expect(model.calls[1]!.messages.some((message) => message.role === "tool")).toBe(true);
  });
});

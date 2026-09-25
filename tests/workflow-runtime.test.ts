import { describe, expect, it } from "vitest";
import type { AgentConfig, ConsentRecord, ConversationState, ToolExecutionResult } from "../src/core/types.js";
import { WorkflowRuntime } from "../src/workflows/runtime.js";
import type { PlatformStore } from "../src/storage/dynamo.js";
import type { ToolRegistry } from "../src/core/tool-registry.js";

class FakeStore {
  consents = new Set<string>();
  audits: Array<{ action: string; data: Record<string, unknown> }> = [];

  async hasConsent(_tenantId: string, subjectId: string, policyId: string, version = "1") {
    return this.consents.has(`${subjectId}:${policyId}:${version}`);
  }

  async recordConsent(record: ConsentRecord) {
    this.consents.add(`${record.subjectId}:${record.policyId}:${record.version}`);
  }

  async audit(_tenantId: string, action: string, data: Record<string, unknown>) {
    this.audits.push({ action, data });
  }
}

class FakeTools {
  calls: string[] = [];

  async executeByName(
    _tenant: AgentConfig,
    name: string,
    _ctx: unknown,
    input: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    this.calls.push(name);
    if (name === "resolve_customer") return { ok: true, data: { customerId: "c-1", phone: "+593999999999" } };
    if (name === "send_otp") return { ok: true, data: { challengeId: "challenge-1" } };
    if (name === "verify_otp") return { ok: true, data: { verified: input.code === "123456" } };
    if (name === "list_accounts") return { ok: true, data: [{ id: "a-1", label: "Cuenta ****1234" }] };
    if (name === "balance") return { ok: true, data: { available: "10.00", ledger: "12.00" } };
    return { ok: false, error: { code: "UNKNOWN", message: "unknown" } };
  }
}

const tenant: AgentConfig = {
  tenantId: "bank",
  displayName: "Bank",
  enabled: true,
  systemPrompt: "Assistant",
  tools: [
    { name: "resolve_customer", kind: "http", exposure: "workflow", description: "", inputSchema: {}, http: { method: "POST", url: "https://example.com" } },
    { name: "send_otp", kind: "http", exposure: "workflow", description: "", inputSchema: {}, http: { method: "POST", url: "https://example.com" } },
    { name: "verify_otp", kind: "http", exposure: "workflow", description: "", inputSchema: {}, http: { method: "POST", url: "https://example.com" } },
    { name: "list_accounts", kind: "http", exposure: "workflow", description: "", inputSchema: {}, http: { method: "POST", url: "https://example.com" } },
    { name: "balance", kind: "http", exposure: "workflow", description: "", inputSchema: {}, http: { method: "POST", url: "https://example.com" } },
  ],
  workflows: [{
    id: "balance",
    name: "Balance",
    description: "Balance flow",
    steps: [
      { id: "consent", type: "consent", policyId: "privacy", prompt: "¿Acepta?" },
      { id: "id", type: "collect", field: "identification", prompt: "Identificación", transform: "digits", validation: { minLength: 3 } },
      { id: "resolve", type: "tool", tool: "resolve_customer", input: { id: "{{identification}}" }, saveAs: "identity" },
      {
        id: "verify",
        type: "verification",
        startTool: "send_otp",
        startInput: { customerId: "{{identity.customerId}}" },
        verifyTool: "verify_otp",
        verifyInput: { challengeId: "{{_verification.verify.challengeId}}", code: "{{input}}" },
        successPath: "verified",
        subjectFrom: "identity.customerId",
        prompt: "Código OTP",
      },
      { id: "accounts", type: "tool", tool: "list_accounts", input: { customerId: "{{identity.customerId}}" }, saveAs: "accounts" },
      { id: "choose", type: "select", field: "account", prompt: "Seleccione", source: "accounts", valuePath: "id", labelPath: "label", autoSelectSingle: true },
      { id: "balance", type: "tool", tool: "balance", input: { accountId: "{{account.id}}" }, saveAs: "balance" },
      { id: "render", type: "render", template: "Disponible {{balance.available}} / contable {{balance.ledger}}" },
      { id: "end", type: "end", message: "Fin" },
    ],
  }],
};

function state(): ConversationState {
  return {
    tenantId: "bank",
    channel: "whatsapp",
    conversationId: "5939",
    userId: "5939",
    mode: "ai",
    messages: [],
    verification: { level: "none" },
    updatedAt: new Date().toISOString(),
  };
}

describe("WorkflowRuntime", () => {
  it("runs consent, identity, external OTP, selection and deterministic rendering without an LLM", async () => {
    const store = new FakeStore();
    const tools = new FakeTools();
    const runtime = new WorkflowRuntime(store as unknown as PlatformStore, tools as unknown as ToolRegistry);
    const conversation = state();

    expect((await runtime.start(tenant, conversation, "balance", "m1")).text).toContain("¿Acepta?");
    expect((await runtime.handleInput(tenant, conversation, "sí", "m2")).text).toContain("Identificación");
    expect((await runtime.handleInput(tenant, conversation, "123-45", "m3")).text).toContain("Código OTP");

    const invalid = await runtime.handleInput(tenant, conversation, "000000", "m4");
    expect(invalid.text).toContain("El código ingresado no es válido");
    expect(conversation.verification.level).toBe("none");

    const success = await runtime.handleInput(tenant, conversation, "123456", "m5");
    expect(success.text).toContain("Disponible 10.00 / contable 12.00");
    expect(success.text).toContain("Fin");
    expect(conversation.verification.level).toBe("otp");
    expect(conversation.verification.subjectId).toBe("c-1");
    expect(conversation.workflow?.status).toBe("completed");
    expect(tools.calls).toEqual(["resolve_customer", "send_otp", "verify_otp", "verify_otp", "list_accounts", "balance"]);
  });

  it("does not reuse an OTP session verified for another subject", async () => {
    const store = new FakeStore();
    const tools = new FakeTools();
    const runtime = new WorkflowRuntime(store as unknown as PlatformStore, tools as unknown as ToolRegistry);
    const conversation = state();
    conversation.verification = {
      level: "otp",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      subjectId: "different-customer",
    };

    expect((await runtime.start(tenant, conversation, "balance", "m1")).text).toContain("¿Acepta?");
    expect((await runtime.handleInput(tenant, conversation, "sí", "m2")).text).toContain("Identificación");
    const result = await runtime.handleInput(tenant, conversation, "12345", "m3");

    expect(result.text).toContain("Código OTP");
    expect(tools.calls).toEqual(["resolve_customer", "send_otp"]);
  });

  it("reuses an active OTP session only for the same subject", async () => {
    const store = new FakeStore();
    const tools = new FakeTools();
    const runtime = new WorkflowRuntime(store as unknown as PlatformStore, tools as unknown as ToolRegistry);
    const conversation = state();
    conversation.verification = {
      level: "otp",
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      subjectId: "c-1",
    };

    expect((await runtime.start(tenant, conversation, "balance", "m1")).text).toContain("¿Acepta?");
    expect((await runtime.handleInput(tenant, conversation, "sí", "m2")).text).toContain("Identificación");
    const result = await runtime.handleInput(tenant, conversation, "12345", "m3");

    expect(result.text).toContain("Disponible 10.00 / contable 12.00");
    expect(tools.calls).toEqual(["resolve_customer", "list_accounts", "balance"]);
  });

  it("persists consent for future workflow runs", async () => {
    const store = new FakeStore();
    const tools = new FakeTools();
    const runtime = new WorkflowRuntime(store as unknown as PlatformStore, tools as unknown as ToolRegistry);
    const first = state();

    await runtime.start(tenant, first, "balance", "m1");
    await runtime.handleInput(tenant, first, "acepto", "m2");
    expect(store.consents.has("5939:privacy:1")).toBe(true);

    const second = state();
    const result = await runtime.start(tenant, second, "balance", "m3");
    expect(result.text).toContain("Identificación");
  });
});

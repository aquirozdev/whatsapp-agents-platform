import { describe, expect, it } from "vitest";
import { validateAgentConfig } from "../src/core/config-validation.js";
import type { AgentConfig } from "../src/core/types.js";

function config(): AgentConfig {
  return {
    tenantId: "t1",
    displayName: "Tenant",
    enabled: true,
    systemPrompt: "Helpful assistant",
    tools: [{
      name: "lookup",
      kind: "http",
      description: "Lookup",
      inputSchema: { type: "object" },
      http: { method: "GET", url: "https://example.com" },
    }],
    workflows: [{
      id: "lookup-flow",
      name: "Lookup",
      description: "Deterministic lookup",
      steps: [
        { id: "call", type: "tool", tool: "lookup", saveAs: "result" },
        { id: "done", type: "end", message: "Done" },
      ],
    }],
  };
}

describe("validateAgentConfig", () => {
  it("accepts a valid workflow config", () => {
    expect(validateAgentConfig(config())).toEqual([]);
  });

  it("rejects unknown tool references", () => {
    const value = config();
    value.workflows![0]!.steps[0] = { id: "call", type: "tool", tool: "missing" };
    expect(validateAgentConfig(value).some((issue) => issue.message.includes("Unknown tool reference"))).toBe(true);
  });

  it("rejects the reserved start_workflow tool name", () => {
    const value = config();
    value.tools[0]!.name = "start_workflow";
    expect(validateAgentConfig(value).some((issue) => issue.message.includes("reserved"))).toBe(true);
  });

  it("validates WhatsApp Graph API and timeout settings", () => {
    const value = config();
    value.whatsapp = {
      phoneNumberId: "abc",
      accessTokenSecretArn: "",
      graphApiVersion: "latest",
      sendTimeoutMs: 100,
    };
    const issues = validateAgentConfig(value);
    expect(issues.some((issue) => issue.path === "whatsapp.phoneNumberId")).toBe(true);
    expect(issues.some((issue) => issue.path === "whatsapp.graphApiVersion")).toBe(true);
    expect(issues.some((issue) => issue.path === "whatsapp.accessTokenSecret")).toBe(true);
    expect(issues.some((issue) => issue.path === "whatsapp.sendTimeoutMs")).toBe(true);
  });

  it("accepts portable model and secret references", () => {
    const value = config();
    value.model = {
      provider: "openai",
      model: "gpt-test",
      apiKeySecret: { key: "models.openai.api-key" },
      baseUrl: "https://api.openai.com/v1",
    };
    value.whatsapp = {
      phoneNumberId: "12345",
      accessTokenSecret: { key: "whatsapp.access-token" },
      graphApiVersion: "v23.0",
    };
    expect(validateAgentConfig(value)).toEqual([]);
  });

  it("rejects unsupported portable schema keywords", () => {
    const value = config();
    value.tools[0]!.inputSchema = {
      type: "object",
      oneOf: [{ type: "string" }, { type: "number" }],
    };
    expect(validateAgentConfig(value).some((issue) => issue.message.includes("portable tool-schema subset"))).toBe(true);
  });

  it("validates OTP safety bounds", () => {
    const value = config();
    value.otp = {
      enabled: true,
      codeTtlSeconds: 5,
      sessionTtlSeconds: 30,
      maxAttempts: 0,
      requestCooldownSeconds: 5000,
    };
    const issues = validateAgentConfig(value);
    expect(issues.some((issue) => issue.path === "otp.codeTtlSeconds")).toBe(true);
    expect(issues.some((issue) => issue.path === "otp.sessionTtlSeconds")).toBe(true);
    expect(issues.some((issue) => issue.path === "otp.maxAttempts")).toBe(true);
    expect(issues.some((issue) => issue.path === "otp.requestCooldownSeconds")).toBe(true);
  });

  it("validates HTTP execution bounds", () => {
    const value = config();
    value.tools[0]!.http = {
      method: "GET",
      url: "https://example.com",
      timeoutMs: 70000,
      maxResponseBytes: 6 * 1024 * 1024,
    };
    const issues = validateAgentConfig(value);
    expect(issues.some((issue) => issue.path.endsWith(".http.timeoutMs"))).toBe(true);
    expect(issues.some((issue) => issue.path.endsWith(".http.maxResponseBytes"))).toBe(true);
  });
});

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
});

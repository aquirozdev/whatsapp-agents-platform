import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../src/core/policy-engine.js";
import type { ConversationState, ToolBinding } from "../src/core/types.js";

const state: ConversationState = {
  tenantId: "t1", channel: "web", conversationId: "c1", userId: "u1", mode: "ai",
  messages: [], verification: { level: "otp", expiresAt: 200, subjectId: "customer-1" },
  updatedAt: new Date().toISOString(),
};

const tool: ToolBinding = {
  name: "get_balance", kind: "http", description: "balance", inputSchema: { type: "object" },
  requiresVerification: "otp", verificationSubjectFrom: "customerId",
  http: { method: "POST", url: "https://example.com/balance" },
};

describe("verification subject binding", () => {
  it("allows the verified identity", () => {
    expect(() => new PolicyEngine().assertToolAllowed(tool, state, { customerId: "customer-1" }, 100)).not.toThrow();
  });
  it("blocks a different identity even while OTP is active", () => {
    expect(() => new PolicyEngine().assertToolAllowed(tool, state, { customerId: "customer-2" }, 100)).toThrow(/does not match/);
  });
});

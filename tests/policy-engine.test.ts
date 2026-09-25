import { describe, expect, it } from "vitest";
import { PolicyEngine } from "../src/core/policy-engine.js";
import type { ConversationState, ToolBinding } from "../src/core/types.js";

const binding: ToolBinding = {
  name: "balance",
  kind: "http",
  description: "balance",
  inputSchema: { type: "object" },
  requiresVerification: "otp",
  http: { method: "POST", url: "https://example.com" },
};

const state: ConversationState = {
  tenantId: "t1",
  channel: "web",
  conversationId: "c1",
  userId: "u1",
  mode: "ai",
  messages: [],
  verification: { level: "none" },
  updatedAt: new Date().toISOString(),
};

describe("PolicyEngine", () => {
  it("blocks protected tools without verification", () => {
    expect(() => new PolicyEngine().assertToolAllowed(binding, state, {}, 100)).toThrowError(/requires otp verification/);
  });

  it("allows protected tools with valid verification", () => {
    const verified = { ...state, verification: { level: "otp" as const, expiresAt: 200 } };
    expect(() => new PolicyEngine().assertToolAllowed(binding, verified, {}, 100)).not.toThrow();
  });
});

import type { AgentConfig, ToolBinding, ToolContext, ToolExecutionResult } from "./types.js";
import { PolicyEngine } from "./policy-engine.js";
import { executeHttpTool } from "../tools/http-tool.js";
import { OtpService } from "../tools/otp-tools.js";
import { PlatformStore } from "../storage/dynamo.js";
import { getPath } from "./template.js";

export type ToolCaller = "agent" | "workflow";

export class ToolRegistry {
  private readonly policy = new PolicyEngine();
  private readonly otp: OtpService;

  constructor(private readonly store: PlatformStore) { this.otp = new OtpService(store); }

  getAgentBindings(tenant: AgentConfig): ToolBinding[] {
    return tenant.tools.filter((binding) => (binding.exposure ?? "both") !== "workflow");
  }

  async executeByName(tenant: AgentConfig, name: string, ctx: ToolContext, input: Record<string, unknown>, caller: ToolCaller): Promise<ToolExecutionResult> {
    const binding = tenant.tools.find((item) => item.name === name);
    if (!binding) return { ok: false, error: { code: "UNKNOWN_TOOL", message: `Unknown tool ${name}.` } };
    const exposure = binding.exposure ?? "both";
    if (caller === "agent" && exposure === "workflow") return { ok: false, error: { code: "TOOL_NOT_EXPOSED", message: `Tool ${name} is workflow-only.` } };
    if (caller === "workflow" && exposure === "agent") return { ok: false, error: { code: "TOOL_NOT_EXPOSED", message: `Tool ${name} is agent-only.` } };
    return this.execute(binding, ctx, input);
  }

  async execute(binding: ToolBinding, ctx: ToolContext, input: Record<string, unknown>): Promise<ToolExecutionResult> {
    try {
      this.policy.assertToolAllowed(binding, ctx.state, input);
    } catch (error) {
      if (error instanceof Error && [
        "VERIFICATION_REQUIRED",
        "VERIFICATION_SUBJECT_MISSING",
        "VERIFICATION_SUBJECT_MISMATCH",
      ].includes(error.name)) {
        return { ok: false, error: { code: error.name, message: error.message } };
      }
      throw error;
    }

    for (const requirement of binding.requiresConsents ?? []) {
      const rawSubject = requirement.subjectFrom ? getPath(input, requirement.subjectFrom) : ctx.state.userId;
      if (rawSubject === undefined || rawSubject === null || String(rawSubject).trim() === "") {
        return { ok: false, error: { code: "CONSENT_SUBJECT_MISSING", message: `Tool ${binding.name} cannot resolve the required consent subject.` } };
      }
      const hasConsent = await this.store.hasConsent(ctx.tenant.tenantId, String(rawSubject), requirement.policyId, requirement.version ?? "1");
      if (!hasConsent) return { ok: false, error: { code: "CONSENT_REQUIRED", message: `Tool ${binding.name} requires consent for policy ${requirement.policyId}.` } };
    }

    if (binding.kind === "http") {
      if (!binding.http) return { ok: false, error: { code: "INVALID_TOOL_CONFIG", message: `HTTP configuration missing for ${binding.name}.` } };
      return executeHttpTool(binding.http, input, ctx.externalMessageId);
    }

    switch (binding.name) {
      case "request_verification": return this.otp.request(ctx, input);
      case "verify_code": return this.otp.verify(ctx, input);
      case "human_handoff":
        ctx.state.mode = "human";
        await this.store.audit(ctx.tenant.tenantId, "conversation.handoff", { userId: ctx.state.userId, reason: input.reason ?? "agent_requested" });
        return { ok: true, data: { handoff: true } };
      default: return { ok: false, error: { code: "UNKNOWN_TOOL", message: `Unknown builtin tool ${binding.name}.` } };
    }
  }
}

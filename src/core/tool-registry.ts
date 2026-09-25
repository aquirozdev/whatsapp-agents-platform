import type { AgentConfig, ToolBinding, ToolContext, ToolExecutionResult } from "./types.js";
import { PolicyEngine } from "./policy-engine.js";
import type { PlatformStorePort } from "../ports/store.js";
import type { ToolExecutorRegistry } from "../ports/tool-executor.js";
import { getPath } from "./template.js";
import { validateToolInput } from "./input-validation.js";
import { noopObservability, observe, type ObservabilityPort } from "../ports/observability.js";

export type ToolCaller = "agent" | "workflow";

export class ToolRegistry {
  private readonly policy = new PolicyEngine();

  constructor(
    private readonly store: PlatformStorePort,
    private readonly executors: ToolExecutorRegistry,
    private readonly observability: ObservabilityPort = noopObservability,
  ) {}

  getAgentBindings(tenant: AgentConfig): ToolBinding[] {
    return tenant.tools.filter((binding) => (binding.exposure ?? "both") !== "workflow");
  }

  async executeByName(
    tenant: AgentConfig,
    name: string,
    ctx: ToolContext,
    input: Record<string, unknown>,
    caller: ToolCaller,
  ): Promise<ToolExecutionResult> {
    const binding = tenant.tools.find((item) => item.name === name);
    if (!binding) return { ok: false, error: { code: "UNKNOWN_TOOL", message: `Unknown tool ${name}.` } };

    const exposure = binding.exposure ?? "both";
    if (caller === "agent" && exposure === "workflow") {
      return { ok: false, error: { code: "TOOL_NOT_EXPOSED", message: `Tool ${name} is workflow-only.` } };
    }
    if (caller === "workflow" && exposure === "agent") {
      return { ok: false, error: { code: "TOOL_NOT_EXPOSED", message: `Tool ${name} is agent-only.` } };
    }
    return this.execute(binding, ctx, input);
  }

  async execute(binding: ToolBinding, ctx: ToolContext, input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const inputValidation = validateToolInput(binding.inputSchema, input);
    if (!inputValidation.ok) {
      await this.store.audit(ctx.tenant.tenantId, "tool.input_rejected", {
        tool: binding.name,
        userId: ctx.state.userId,
        reason: inputValidation.message,
      });
      return {
        ok: false,
        error: {
          code: "TOOL_INPUT_INVALID",
          message: `Invalid input for ${binding.name}: ${inputValidation.message}`,
        },
      };
    }

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
        return {
          ok: false,
          error: {
            code: "CONSENT_SUBJECT_MISSING",
            message: `Tool ${binding.name} cannot resolve the required consent subject.`,
          },
        };
      }
      const hasConsent = await this.store.hasConsent(
        ctx.tenant.tenantId,
        String(rawSubject),
        requirement.policyId,
        requirement.version ?? "1",
      );
      if (!hasConsent) {
        return {
          ok: false,
          error: {
            code: "CONSENT_REQUIRED",
            message: `Tool ${binding.name} requires consent for policy ${requirement.policyId}.`,
          },
        };
      }
    }

    if (binding.rateLimit) {
      const scope = binding.rateLimit.scope ?? "user";
      const subject = scope === "tenant"
        ? "tenant"
        : scope === "conversation"
          ? ctx.state.conversationId
          : ctx.state.userId;
      const allowed = await this.store.claimToolRateSlot(
        ctx.tenant.tenantId,
        binding.name,
        subject,
        binding.rateLimit.windowSeconds,
        binding.rateLimit.maxCalls,
      );
      if (!allowed) {
        this.observability.metric({ name: "ToolRateLimited", value: 1, dimensions: { ToolKind: binding.kind } });
        return {
          ok: false,
          error: {
            code: "TOOL_RATE_LIMITED",
            message: `Rate limit exceeded for tool ${binding.name}.`,
            retryable: true,
            category: "rate_limit",
          },
        };
      }
    }

    const executor = this.executors.get(binding.kind);
    if (!executor) {
      return {
        ok: false,
        error: {
          code: "TOOL_EXECUTOR_NOT_REGISTERED",
          message: `No executor is registered for tool kind ${binding.kind}.`,
        },
      };
    }
    const started = Date.now();
    const result = await observe(
      this.observability,
      "tool.execute",
      { "tool.name": binding.name, "tool.kind": binding.kind, "tool.caller": "runtime" },
      () => executor.execute(binding, ctx, input),
    );
    this.observability.metric({ name: "ToolLatency", value: Date.now() - started, unit: "Milliseconds", dimensions: { ToolKind: binding.kind } });
    this.observability.metric({ name: result.ok ? "ToolSuccess" : "ToolError", value: 1, dimensions: { ToolKind: binding.kind } });
    return result;
  }
}

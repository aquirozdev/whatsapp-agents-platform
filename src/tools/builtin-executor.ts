import type { ToolBinding, ToolContext, ToolExecutionResult } from "../core/types.js";
import type { OtpDeliveryPort } from "../ports/otp-delivery.js";
import type { SecretProvider } from "../ports/secrets.js";
import type { PlatformStorePort } from "../ports/store.js";
import type { ToolExecutor } from "../ports/tool-executor.js";
import { OtpService } from "./otp-tools.js";

export class BuiltinToolExecutor implements ToolExecutor {
  readonly kind = "builtin";
  private readonly otp: OtpService;

  constructor(
    private readonly store: PlatformStorePort,
    secrets: SecretProvider,
    otpDelivery: OtpDeliveryPort,
    otpHmacSecret: string,
  ) {
    this.otp = new OtpService(store, secrets, otpDelivery, otpHmacSecret);
  }

  async execute(binding: ToolBinding, ctx: ToolContext, input: Record<string, unknown>): Promise<ToolExecutionResult> {
    switch (binding.name) {
      case "request_verification":
        return this.otp.request(ctx, input);
      case "verify_code":
        return this.otp.verify(ctx, input);
      case "human_handoff":
        ctx.state.mode = "human";
        await this.store.audit(ctx.tenant.tenantId, "conversation.handoff", {
          userId: ctx.state.userId,
          reason: input.reason ?? "agent_requested",
        });
        return { ok: true, data: { handoff: true } };
      default:
        return { ok: false, error: { code: "UNKNOWN_TOOL", message: `Unknown builtin tool ${binding.name}.` } };
    }
  }
}

import type { ToolBinding, ToolContext, ToolExecutionResult } from "../core/types.js";
import type { ToolExecutor } from "../ports/tools.js";
import { HttpToolExecutor } from "./http-tool.js";
import { OtpService } from "./otp-tools.js";

export class DefaultToolExecutor implements ToolExecutor {
  constructor(
    private readonly http: HttpToolExecutor,
    private readonly otp: OtpService,
  ) {}

  async execute(binding: ToolBinding, ctx: ToolContext, input: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (binding.kind === "http") {
      if (!binding.http) {
        return {
          ok: false,
          error: { code: "INVALID_TOOL_CONFIG", message: `HTTP configuration missing for ${binding.name}.` },
        };
      }
      return this.http.execute(binding.http, input, ctx.externalMessageId);
    }

    switch (binding.name) {
      case "request_verification":
        return this.otp.request(ctx, input);
      case "verify_code":
        return this.otp.verify(ctx, input);
      default:
        return {
          ok: false,
          error: { code: "UNKNOWN_TOOL", message: `Unknown builtin tool ${binding.name}.` },
        };
    }
  }
}

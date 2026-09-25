import type { ToolBinding, ToolContext, ToolExecutionResult } from "../core/types.js";
import type { SecretProvider } from "../ports/secrets.js";
import type { ToolExecutor } from "../ports/tool-executor.js";
import { executeHttpTool } from "./http-tool.js";

export class HttpToolExecutor implements ToolExecutor {
  readonly kind = "http";

  constructor(private readonly secrets: SecretProvider) {}

  async execute(binding: ToolBinding, ctx: ToolContext, input: Record<string, unknown>): Promise<ToolExecutionResult> {
    if (!binding.http) {
      return { ok: false, error: { code: "INVALID_TOOL_CONFIG", message: `HTTP configuration missing for ${binding.name}.` } };
    }
    return executeHttpTool(binding.http, input, this.secrets, ctx.externalMessageId);
  }
}

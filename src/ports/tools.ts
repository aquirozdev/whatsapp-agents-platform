import type { ToolBinding, ToolContext, ToolExecutionResult } from "../core/types.js";

export interface ToolExecutor {
  execute(binding: ToolBinding, ctx: ToolContext, input: Record<string, unknown>): Promise<ToolExecutionResult>;
}

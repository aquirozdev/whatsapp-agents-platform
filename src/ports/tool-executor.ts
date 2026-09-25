import type { ToolBinding, ToolContext, ToolExecutionResult } from "../core/types.js";

export interface ToolExecutor {
  readonly kind: string;
  execute(binding: ToolBinding, ctx: ToolContext, input: Record<string, unknown>): Promise<ToolExecutionResult>;
}

export class ToolExecutorRegistry {
  private readonly executors = new Map<string, ToolExecutor>();

  constructor(executors: ToolExecutor[] = []) {
    for (const executor of executors) this.register(executor);
  }

  register(executor: ToolExecutor): void {
    if (this.executors.has(executor.kind)) throw new Error(`Tool executor ${executor.kind} is already registered.`);
    this.executors.set(executor.kind, executor);
  }

  get(kind: string): ToolExecutor | undefined {
    return this.executors.get(kind);
  }

  has(kind: string): boolean {
    return this.executors.has(kind);
  }
}

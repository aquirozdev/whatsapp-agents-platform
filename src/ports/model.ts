import type { JsonSchema, ModelConfig } from "../core/types.js";

export type ModelContent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; result: unknown; isError?: boolean };

export interface ModelMessage {
  role: "user" | "assistant";
  content: ModelContent[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ModelRequest {
  model: ModelConfig;
  system: string;
  messages: ModelMessage[];
  tools: ModelToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

export interface ModelResponse {
  message: ModelMessage;
  text: string;
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  usage?: ModelUsage;
  finishReason?: string;
  providerRequestId?: string;
  metadata?: Record<string, unknown>;
}

export interface ModelCapabilities {
  toolCalling: boolean;
  parallelToolCalls: boolean;
  structuredOutput: boolean;
  vision: boolean;
  documents: boolean;
  streaming: boolean;
}

export interface ModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export class ModelProviderRegistry {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(providers: ModelProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: ModelProvider): void {
    if (this.providers.has(provider.id)) throw new Error(`Model provider ${provider.id} is already registered.`);
    this.providers.set(provider.id, provider);
  }

  get(id: string): ModelProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Model provider ${id} is not registered.`);
    return provider;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }
}

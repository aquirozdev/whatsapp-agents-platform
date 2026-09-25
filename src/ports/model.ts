import type { JsonSchema, ModelConfig } from "../core/types.js";

export type ModelContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; id: string; name?: string; result: unknown; isError?: boolean };

export interface ModelMessage {
  role: "user" | "assistant" | "tool";
  content: ModelContentBlock[];
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface ModelRequest {
  config: ModelConfig;
  system: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  maxTokens?: number;
  temperature?: number;
}

export interface ModelResponse {
  content: ModelContentBlock[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface ModelCapabilities {
  toolCalling: boolean;
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

export interface ModelProviderResolver {
  resolve(config: ModelConfig): ModelProvider;
}

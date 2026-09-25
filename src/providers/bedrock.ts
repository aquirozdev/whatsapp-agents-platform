import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type Message,
  type Tool,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  ModelContentBlock,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "../ports/model.js";

const client = new BedrockRuntimeClient({});

function toBedrockMessage(message: ModelMessage): Message {
  const content: ContentBlock[] = message.content.map((block): ContentBlock => {
    if (block.type === "text") return { text: block.text };
    if (block.type === "tool_call") {
      return {
        toolUse: {
          toolUseId: block.id,
          name: block.name,
          input: block.input as never,
        },
      };
    }
    return {
      toolResult: {
        toolUseId: block.id,
        status: block.isError ? "error" : "success",
        content: [{ json: block.result as never }],
      },
    };
  });

  return {
    role: message.role === "assistant" ? "assistant" : "user",
    content,
  };
}

function fromBedrockContent(content: ContentBlock[]): ModelContentBlock[] {
  return content.flatMap((block): ModelContentBlock[] => {
    if (block.text !== undefined) return [{ type: "text", text: block.text }];
    if (block.toolUse?.toolUseId && block.toolUse.name) {
      return [{
        type: "tool_call",
        id: block.toolUse.toolUseId,
        name: block.toolUse.name,
        input: (block.toolUse.input ?? {}) as Record<string, unknown>,
      }];
    }
    return [];
  });
}

export class BedrockModelProvider implements ModelProvider {
  readonly id = "bedrock";
  readonly capabilities = {
    toolCalling: true,
    structuredOutput: false,
    vision: true,
    documents: true,
    streaming: false,
  } as const;

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const tools: Tool[] | undefined = request.tools?.length
      ? request.tools.map((tool) => ({
          toolSpec: {
            name: tool.name,
            description: tool.description,
            inputSchema: { json: tool.inputSchema as never },
          },
        }))
      : undefined;

    const response = await client.send(new ConverseCommand({
      modelId: request.config.model,
      system: [{ text: request.system }],
      messages: request.messages.map(toBedrockMessage),
      inferenceConfig: {
        maxTokens: request.maxTokens ?? request.config.maxTokens ?? 1200,
        temperature: request.temperature ?? request.config.temperature ?? 0.2,
      },
      toolConfig: tools ? { tools } : undefined,
    }));

    const output = response.output?.message;
    if (!output) throw new Error("Bedrock returned no message output.");

    return {
      content: fromBedrockContent(output.content ?? []),
      usage: {
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
      },
    };
  }
}

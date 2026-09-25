import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type Message } from "@aws-sdk/client-bedrock-runtime";
import type { ModelContent, ModelMessage, ModelProvider, ModelRequest, ModelResponse } from "../../ports/model.js";
import { awsClientOptions } from "./client-options.js";
import { ModelProviderError } from "../../core/errors.js";

function toBedrockMessage(message: ModelMessage): Message {
  const content = message.content.map((block): ContentBlock => {
    if (block.type === "text") return { text: block.text };
    if (block.type === "tool_call") {
      return { toolUse: { toolUseId: block.id, name: block.name, input: block.input as never } };
    }
    return {
      toolResult: {
        toolUseId: block.id,
        status: block.isError ? "error" : "success",
        content: [{ json: block.result as never }],
      },
    };
  });
  return { role: message.role, content };
}

export class BedrockModelProvider implements ModelProvider {
  readonly id = "bedrock";
  readonly capabilities = {
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: false,
    vision: true,
    documents: true,
    streaming: true,
  } as const;

  private readonly client = new BedrockRuntimeClient(awsClientOptions());

  async generate(request: ModelRequest): Promise<ModelResponse> {
    let response;
    try {
      response = await this.client.send(new ConverseCommand({
      modelId: request.model.model,
      system: [{ text: request.system }],
      messages: request.messages.map(toBedrockMessage),
      inferenceConfig: {
        maxTokens: request.maxTokens ?? 1200,
        temperature: request.temperature ?? 0.2,
      },
      toolConfig: request.tools.length ? {
        tools: request.tools.map((tool) => ({
          toolSpec: {
            name: tool.name,
            description: tool.description,
            inputSchema: { json: tool.inputSchema },
          },
        })) as never[],
      } : undefined,
      }));
    } catch (error) {
      const name = error instanceof Error ? error.name : "UnknownError";
      const message = error instanceof Error ? error.message : "Bedrock request failed.";
      if (/Throttl|TooManyRequests|ServiceQuota/i.test(name)) throw new ModelProviderError(message, "MODEL_RATE_LIMIT", "rate_limit", true);
      if (/Timeout/i.test(name)) throw new ModelProviderError(message, "MODEL_TIMEOUT", "timeout", true);
      if (/AccessDenied|Unauthorized|UnrecognizedClient/i.test(name)) throw new ModelProviderError(message, "MODEL_AUTH", "auth", false);
      if (/Validation|ResourceNotFound/i.test(name)) throw new ModelProviderError(message, "MODEL_INVALID_REQUEST", "validation", false);
      throw new ModelProviderError(message, "MODEL_UNAVAILABLE", "unavailable", true, { providerError: name });
    }

    const output = response.output?.message;
    if (!output) throw new Error("Bedrock returned no message output.");

    const content: ModelContent[] = [];
    const toolCalls: ModelResponse["toolCalls"] = [];
    const texts: string[] = [];

    for (const block of output.content ?? []) {
      if (block.text) {
        texts.push(block.text);
        content.push({ type: "text", text: block.text });
      }
      if (block.toolUse?.name && block.toolUse.toolUseId) {
        const input = block.toolUse.input && typeof block.toolUse.input === "object"
          ? block.toolUse.input as Record<string, unknown>
          : {};
        const call = { id: block.toolUse.toolUseId, name: block.toolUse.name, input };
        toolCalls.push(call);
        content.push({ type: "tool_call", ...call });
      }
    }

    return {
      message: { role: "assistant", content },
      text: texts.join("\n").trim(),
      toolCalls,
      usage: {
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        totalTokens: response.usage?.totalTokens,
      },
      finishReason: response.stopReason,
      providerRequestId: response.$metadata.requestId,
    };
  }
}

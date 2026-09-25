import type { SecretProvider } from "../ports/secrets.js";
import type { ModelContent, ModelMessage, ModelProvider, ModelRequest, ModelResponse } from "../ports/model.js";
import { modelErrorFromHttp, modelTimeoutError, ModelProviderError } from "../core/errors.js";

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

function toOpenAIMessages(request: ModelRequest): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [{ role: "system", content: request.system }];

  for (const message of request.messages) {
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => block.type === "text" ? block.text : "")
      .join("\n");

    const calls = message.content.flatMap((block) => block.type === "tool_call"
      ? [{
          id: block.id,
          type: "function" as const,
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        }]
      : []);

    if (message.role === "assistant") {
      messages.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }

    const toolResults = message.content.filter((block) => block.type === "tool_result");
    if (toolResults.length) {
      for (const block of toolResults) {
        if (block.type !== "tool_result") continue;
        messages.push({
          role: "tool",
          tool_call_id: block.id,
          content: JSON.stringify(block.result),
        });
      }
    } else {
      messages.push({ role: "user", content: text });
    }
  }

  return messages;
}

export class OpenAICompatibleModelProvider implements ModelProvider {
  readonly id = "openai";
  readonly capabilities = {
    toolCalling: true,
    parallelToolCalls: true,
    structuredOutput: true,
    vision: false,
    documents: false,
    streaming: false,
  } as const;

  constructor(private readonly secrets: SecretProvider) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    if (!request.model.apiKeySecret) {
      throw new Error("OpenAI-compatible provider requires model.apiKeySecret.");
    }

    const apiKey = await this.secrets.get(request.model.apiKeySecret);
    const baseUrl = (request.model.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model.model,
        messages: toOpenAIMessages(request),
        temperature: request.temperature ?? request.model.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? request.model.maxTokens ?? 1200,
        tools: request.tools.length ? request.tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })) : undefined,
      }),
      signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw modelTimeoutError();
      throw new ModelProviderError(error instanceof Error ? error.message : "OpenAI-compatible request failed.", "MODEL_UNAVAILABLE", "unavailable", true);
    }

    const payload = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
      error?: { message?: string };
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      id?: string;
    };

    if (!response.ok) {
      throw modelErrorFromHttp(
        response.status,
        `OpenAI-compatible model request failed (${response.status}): ${payload.error?.message ?? "unknown error"}`,
      );
    }

    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error("OpenAI-compatible provider returned no message.");

    const content: ModelContent[] = [];
    const toolCalls: ModelResponse["toolCalls"] = [];
    const text = message.content?.trim() ?? "";
    if (text) content.push({ type: "text", text });

    for (const call of message.tool_calls ?? []) {
      if (!call.id || !call.function?.name) continue;
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(call.function.arguments ?? "{}") as Record<string, unknown>;
      } catch {
        throw new Error(`Model returned invalid JSON arguments for tool ${call.function.name}.`);
      }
      const toolCall = { id: call.id, name: call.function.name, input };
      toolCalls.push(toolCall);
      content.push({ type: "tool_call", ...toolCall });
    }

    return {
      message: { role: "assistant", content },
      text,
      toolCalls,
      usage: {
        inputTokens: payload.usage?.prompt_tokens,
        outputTokens: payload.usage?.completion_tokens,
        cachedInputTokens: payload.usage?.prompt_tokens_details?.cached_tokens,
        totalTokens: payload.usage?.total_tokens,
      },
      finishReason: undefined,
      providerRequestId: payload.id,
    };
  }
}

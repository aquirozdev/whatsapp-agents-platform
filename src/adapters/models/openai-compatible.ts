import type { SecretProvider } from "../../ports/secrets.js";
import type {
  ModelContent,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "../../ports/model.js";

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

interface OpenAIResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

function portableToOpenAi(messages: ModelMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const text = message.content
        .filter((block): block is Extract<ModelContent, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();

      const calls = message.content
        .filter((block): block is Extract<ModelContent, { type: "tool_call" }> => block.type === "tool_call")
        .map((block) => ({
          id: block.id,
          type: "function" as const,
          function: { name: block.name, arguments: JSON.stringify(block.input) },
        }));

      result.push({
        role: "assistant",
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }

    const text = message.content
      .filter((block): block is Extract<ModelContent, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (text) result.push({ role: "user", content: text });

    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      result.push({
        role: "tool",
        tool_call_id: block.id,
        content: JSON.stringify(block.result),
      });
    }
  }

  return result;
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
    if (!request.model.apiKeySecret?.key) {
      throw new Error("OpenAI-compatible provider requires model.apiKeySecret.");
    }

    const apiKey = await this.secrets.get(request.model.apiKeySecret);
    const baseUrl = (request.model.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.model.model,
        messages: [
          { role: "system", content: request.system },
          ...portableToOpenAi(request.messages),
        ],
        tools: request.tools.length
          ? request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            }))
          : undefined,
        max_tokens: request.model.maxTokens ?? request.maxTokens ?? 1200,
        temperature: request.model.temperature ?? request.temperature ?? 0.2,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const payload = await response.json() as OpenAIResponse;
    if (!response.ok) {
      throw new Error(
        `OpenAI-compatible request failed (${response.status}): ${payload.error?.message ?? "unknown error"}`,
      );
    }

    const responseMessage = payload.choices?.[0]?.message;
    if (!responseMessage) throw new Error("OpenAI-compatible provider returned no message.");

    const content: ModelContent[] = [];
    const toolCalls: ModelResponse["toolCalls"] = [];
    const text = responseMessage.content?.trim() ?? "";

    if (text) content.push({ type: "text", text });

    for (const rawCall of responseMessage.tool_calls ?? []) {
      const id = rawCall.id;
      const name = rawCall.function?.name;
      if (!id || !name) continue;

      let input: Record<string, unknown>;
      try {
        input = JSON.parse(rawCall.function?.arguments ?? "{}") as Record<string, unknown>;
      } catch {
        throw new Error(`Model returned invalid JSON arguments for tool ${name}.`);
      }

      const call = { id, name, input };
      toolCalls.push(call);
      content.push({ type: "tool_call", ...call });
    }

    return {
      message: { role: "assistant", content },
      text,
      toolCalls,
    };
  }
}

import type { SecretProvider } from "../ports/secrets.js";
import type {
  ModelContentBlock,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
} from "../ports/model.js";

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

function toMessages(request: ModelRequest): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [{ role: "system", content: request.system }];

  for (const message of request.messages) {
    if (message.role === "assistant") {
      const text = message.content.filter((x) => x.type === "text").map((x) => x.type === "text" ? x.text : "").join("\n");
      const toolCalls = message.content.flatMap((x) => x.type === "tool_call"
        ? [{ id: x.id, type: "function" as const, function: { name: x.name, arguments: JSON.stringify(x.input) } }]
        : []);
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    if (message.role === "tool") {
      for (const block of message.content) {
        if (block.type !== "tool_result") continue;
        messages.push({
          role: "tool",
          tool_call_id: block.id,
          content: JSON.stringify(block.result),
        });
      }
      continue;
    }

    const text = message.content.filter((x) => x.type === "text").map((x) => x.type === "text" ? x.text : "").join("\n");
    messages.push({ role: "user", content: text });
  }
  return messages;
}

export class OpenAICompatibleModelProvider implements ModelProvider {
  readonly id = "openai";
  readonly capabilities = {
    toolCalling: true,
    structuredOutput: true,
    vision: false,
    documents: false,
    streaming: false,
  } as const;

  constructor(private readonly secrets: SecretProvider) {}

  async generate(request: ModelRequest): Promise<ModelResponse> {
    const apiKeyRef = request.config.apiKeySecret;
    if (!apiKeyRef) throw new Error("OpenAI-compatible provider requires model.apiKeySecret.");
    const apiKey = await this.secrets.get(apiKeyRef);
    const baseUrl = (request.config.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: request.config.model,
        messages: toMessages(request),
        temperature: request.temperature ?? request.config.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? request.config.maxTokens ?? 1200,
        tools: request.tools?.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const payload = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };

    if (!response.ok) throw new Error(`OpenAI-compatible model request failed (${response.status}): ${payload.error?.message ?? "unknown error"}`);

    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error("OpenAI-compatible provider returned no message.");

    const content: ModelContentBlock[] = [];
    if (message.content?.trim()) content.push({ type: "text", text: message.content.trim() });
    for (const call of message.tool_calls ?? []) {
      if (!call.id || !call.function?.name) continue;
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(call.function.arguments ?? "{}") as Record<string, unknown>; }
      catch { throw new Error(`Model returned invalid JSON arguments for tool ${call.function.name}.`); }
      content.push({ type: "tool_call", id: call.id, name: call.function.name, input });
    }

    return {
      content,
      usage: {
        inputTokens: payload.usage?.prompt_tokens,
        outputTokens: payload.usage?.completion_tokens,
      },
    };
  }
}

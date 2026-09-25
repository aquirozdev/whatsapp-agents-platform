import { BedrockRuntimeClient, ConverseCommand, type ContentBlock, type Message } from "@aws-sdk/client-bedrock-runtime";
import type { AgentConfig, ConversationState, OutboundMessage, ToolContext } from "../core/types.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { PlatformStore } from "../storage/dynamo.js";
import { WorkflowRuntime } from "../workflows/runtime.js";

const client = new BedrockRuntimeClient({});

export class BedrockAgent {
  private readonly registry: ToolRegistry;
  private readonly workflows: WorkflowRuntime;

  constructor(private readonly store: PlatformStore) {
    this.registry = new ToolRegistry(store);
    this.workflows = new WorkflowRuntime(store, this.registry);
  }

  async run(
    tenant: AgentConfig,
    state: ConversationState,
    userText: string,
    externalMessageId: string,
  ): Promise<{ text: string; outbound: OutboundMessage[]; toolCalls: string[] }> {
    const modelId = tenant.modelId ?? process.env.DEFAULT_MODEL_ID;
    if (!modelId) throw new Error(`No modelId configured for tenant ${tenant.tenantId} and DEFAULT_MODEL_ID is empty.`);

    const messages: Message[] = state.messages.slice(-20).map((message) => ({
      role: message.role,
      content: [{ text: message.text }],
    }));
    messages.push({ role: "user", content: [{ text: userText }] });

    const agentBindings = this.registry.getAgentBindings(tenant);
    const tools = agentBindings.map((binding) => ({
      toolSpec: {
        name: binding.name,
        description: binding.description,
        inputSchema: { json: binding.inputSchema },
      },
    }));

    const workflowCatalog = tenant.workflows ?? [];
    if (workflowCatalog.length > 0) {
      tools.push({
        toolSpec: {
          name: "start_workflow",
          description: [
            "Start a configured deterministic workflow when the user wants one of these business processes.",
            ...workflowCatalog.map((workflow) => {
              const examples = workflow.triggerExamples?.length ? ` Examples: ${workflow.triggerExamples.join("; ")}` : "";
              return `${workflow.id}: ${workflow.description}.${examples}`;
            }),
            "Do not imitate workflow steps yourself. Start the workflow and let the application control the process.",
          ].join("\n"),
          inputSchema: {
            json: {
              type: "object",
              properties: {
                workflowId: {
                  type: "string",
                  enum: workflowCatalog.map((workflow) => workflow.id),
                },
              },
              required: ["workflowId"],
              additionalProperties: false,
            },
          },
        },
      });
    }

    const toolCalls: string[] = [];
    const maxRounds = tenant.maxToolRounds ?? 6;
    const ctx: ToolContext = { tenant, state, externalMessageId };
    const workflowInstruction = workflowCatalog.length > 0
      ? "\n\nConfigured business workflows are available through start_workflow. Use that tool instead of improvising a transactional flow when the user's intent matches one."
      : "";

    for (let round = 0; round <= maxRounds; round += 1) {
      const response = await client.send(new ConverseCommand({
        modelId,
        system: [{ text: tenant.systemPrompt + workflowInstruction }],
        messages,
        inferenceConfig: { maxTokens: 1200, temperature: 0.2 },
        toolConfig: tools.length > 0 ? { tools: tools as never[] } : undefined,
      }));

      const output = response.output?.message;
      if (!output) throw new Error("Bedrock returned no message output.");
      messages.push(output);

      const toolUses = (output.content ?? []).filter(
        (block): block is ContentBlock & { toolUse: NonNullable<ContentBlock["toolUse"]> } => Boolean(block.toolUse),
      );

      if (toolUses.length === 0) {
        const text = (output.content ?? []).flatMap((block) => block.text ? [block.text] : []).join("\n").trim();
        const finalText = text || "I could not produce a response.";
        return { text: finalText, outbound: [{ kind: "text", text: finalText }], toolCalls };
      }

      if (round === maxRounds) throw new Error(`Maximum tool rounds (${maxRounds}) exceeded.`);

      const workflowUse = toolUses.find((block) => block.toolUse.name === "start_workflow");
      if (workflowUse) {
        const workflowId = (workflowUse.toolUse.input as Record<string, unknown> | undefined)?.workflowId;
        if (typeof workflowId !== "string") throw new Error("start_workflow requires workflowId.");
        toolCalls.push("start_workflow");
        const result = await this.workflows.start(tenant, state, workflowId, externalMessageId);
        return { text: result.text, outbound: result.outbound, toolCalls: [...toolCalls, ...result.toolCalls] };
      }

      const toolResults: ContentBlock[] = [];
      for (const block of toolUses) {
        const use = block.toolUse;
        toolCalls.push(use.name ?? "unknown");
        const result = use.name
          ? await this.registry.executeByName(tenant, use.name, ctx, (use.input ?? {}) as Record<string, unknown>, "agent")
          : { ok: false, error: { code: "UNKNOWN_TOOL", message: "Tool name was missing." } };

        toolResults.push({
          toolResult: {
            toolUseId: use.toolUseId,
            status: result.ok ? "success" : "error",
            content: [{ json: result as never }],
          },
        });
      }

      messages.push({ role: "user", content: toolResults });
    }

    throw new Error("Agent loop ended unexpectedly.");
  }
}

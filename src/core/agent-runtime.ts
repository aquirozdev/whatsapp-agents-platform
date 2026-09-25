import type {
  AgentConfig,
  AgentRunResult,
  InboundEnvelope,
  ModelConfig,
  OutboundMessage,
  ToolContext,
} from "./types.js";
import type {
  ModelContentBlock,
  ModelMessage,
  ModelProviderResolver,
  ModelToolDefinition,
} from "../ports/model.js";
import type { PlatformStorePort } from "../ports/store.js";
import type { ToolExecutor } from "../ports/tools.js";
import { ToolRegistry } from "./tool-registry.js";
import { WorkflowRuntime } from "../workflows/runtime.js";

function tenantModel(tenant: AgentConfig, fallback?: ModelConfig): ModelConfig {
  if (tenant.model) return tenant.model;
  if (tenant.modelId) return { provider: "bedrock", model: tenant.modelId };
  if (fallback) return fallback;
  throw new Error(`No model configured for tenant ${tenant.tenantId}.`);
}

function historyMessages(tenant: AgentConfig, stateMessages: AgentRunResult["state"]["messages"]): ModelMessage[] {
  return stateMessages.slice(-20).map((message) => ({
    role: message.role,
    content: [{ type: "text", text: message.text }],
  }));
}

export class AgentRuntime {
  private readonly tools: ToolRegistry;
  private readonly workflows: WorkflowRuntime;

  constructor(
    private readonly store: PlatformStorePort,
    private readonly models: ModelProviderResolver,
    toolExecutor: ToolExecutor,
    private readonly defaultModel?: ModelConfig,
  ) {
    this.tools = new ToolRegistry(store, toolExecutor);
    this.workflows = new WorkflowRuntime(store, this.tools);
  }

  async execute(activeTenant: AgentConfig, inbound: InboundEnvelope): Promise<AgentRunResult> {
    const state = await this.store.getConversation(
      activeTenant.tenantId,
      inbound.channel,
      inbound.conversationId,
      inbound.userId,
    );

    let tenant = activeTenant;
    const pinnedVersion = state.workflow?.status === "active" ? state.workflow.configVersion : undefined;
    if (pinnedVersion && pinnedVersion !== activeTenant.configVersion) {
      tenant = (await this.store.getTenantVersion(activeTenant.tenantId, pinnedVersion)) ?? activeTenant;
    }

    state.configVersion ??= tenant.configVersion;

    if (state.mode === "human") {
      await this.store.commitTurn(state, inbound.externalMessageId, []);
      return { text: "", outbound: [], state, toolCalls: [] };
    }

    let result: { text: string; outbound: OutboundMessage[]; toolCalls: string[] };
    const routedToWorkflow = state.workflow?.status === "active";

    if (routedToWorkflow) {
      result = await this.workflows.handleInput(tenant, state, inbound.text, inbound.externalMessageId);
    } else {
      result = await this.runAgent(tenant, state, inbound.text, inbound.externalMessageId);
    }

    const startedWorkflow = result.toolCalls.includes("start_workflow");
    if (!routedToWorkflow && !startedWorkflow) {
      state.messages.push({ role: "user", text: inbound.text, at: inbound.receivedAt });
      if (result.text) state.messages.push({ role: "assistant", text: result.text, at: new Date().toISOString() });
    }

    await this.store.commitTurn(state, inbound.externalMessageId, result.outbound);
    await this.store.audit(tenant.tenantId, "agent.response", {
      channel: inbound.channel,
      userId: inbound.userId,
      externalMessageId: inbound.externalMessageId,
      toolCalls: result.toolCalls,
      configVersion: tenant.configVersion,
      workflowId: state.workflow?.workflowId,
      workflowStatus: state.workflow?.status,
    });

    return { text: result.text, outbound: result.outbound, state, toolCalls: result.toolCalls };
  }

  private async runAgent(
    tenant: AgentConfig,
    state: AgentRunResult["state"],
    userText: string,
    externalMessageId: string,
  ): Promise<{ text: string; outbound: OutboundMessage[]; toolCalls: string[] }> {
    const modelConfig = tenantModel(tenant, this.defaultModel);
    const provider = this.models.resolve(modelConfig);
    if (!provider.capabilities.toolCalling && (tenant.tools.length || tenant.workflows?.length)) {
      throw new Error(`Model provider ${provider.id} does not support tool calling required by tenant ${tenant.tenantId}.`);
    }

    const messages = historyMessages(tenant, state.messages);
    messages.push({ role: "user", content: [{ type: "text", text: userText }] });

    const agentBindings = this.tools.getAgentBindings(tenant);
    const modelTools: ModelToolDefinition[] = agentBindings.map((binding) => ({
      name: binding.name,
      description: binding.description,
      inputSchema: binding.inputSchema,
    }));

    const workflows = tenant.workflows ?? [];
    if (workflows.length) {
      modelTools.push({
        name: "start_workflow",
        description: [
          "Start a configured deterministic workflow when the user requests one of these business processes.",
          ...workflows.map((workflow) => {
            const examples = workflow.triggerExamples?.length ? ` Examples: ${workflow.triggerExamples.join("; ")}` : "";
            return `${workflow.id}: ${workflow.description}.${examples}`;
          }),
          "Do not imitate workflow steps yourself. Start the workflow and let the application control the transaction.",
        ].join("\n"),
        inputSchema: {
          type: "object",
          properties: { workflowId: { type: "string", enum: workflows.map((workflow) => workflow.id) } },
          required: ["workflowId"],
          additionalProperties: false,
        },
      });
    }

    const workflowInstruction = workflows.length
      ? "\n\nConfigured business workflows are available through start_workflow. Use it instead of improvising a transactional flow."
      : "";

    const toolCalls: string[] = [];
    const maxRounds = tenant.maxToolRounds ?? 6;
    const ctx: ToolContext = { tenant, state, externalMessageId };

    for (let round = 0; round <= maxRounds; round += 1) {
      const response = await provider.generate({
        config: modelConfig,
        system: tenant.systemPrompt + workflowInstruction,
        messages,
        tools: modelTools.length ? modelTools : undefined,
        maxTokens: modelConfig.maxTokens ?? 1200,
        temperature: modelConfig.temperature ?? 0.2,
      });

      messages.push({ role: "assistant", content: response.content });
      const requestedTools = response.content.filter(
        (block): block is Extract<ModelContentBlock, { type: "tool_call" }> => block.type === "tool_call",
      );

      if (!requestedTools.length) {
        const text = response.content
          .filter((block): block is Extract<ModelContentBlock, { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .trim();
        const finalText = text || "I could not produce a response.";
        return { text: finalText, outbound: [{ kind: "text", text: finalText }], toolCalls };
      }

      if (round === maxRounds) throw new Error(`Maximum tool rounds (${maxRounds}) exceeded.`);

      const workflowCall = requestedTools.find((call) => call.name === "start_workflow");
      if (workflowCall) {
        const workflowId = workflowCall.input.workflowId;
        if (typeof workflowId !== "string") throw new Error("start_workflow requires workflowId.");
        toolCalls.push("start_workflow");
        const result = await this.workflows.start(tenant, state, workflowId, externalMessageId);
        return { text: result.text, outbound: result.outbound, toolCalls: [...toolCalls, ...result.toolCalls] };
      }

      const toolResults: ModelContentBlock[] = [];
      for (const call of requestedTools) {
        toolCalls.push(call.name);
        const result = await this.tools.executeByName(tenant, call.name, ctx, call.input, "agent");
        toolResults.push({
          type: "tool_result",
          id: call.id,
          name: call.name,
          result,
          isError: !result.ok,
        });
      }
      messages.push({ role: "tool", content: toolResults });
    }

    throw new Error("Agent loop ended unexpectedly.");
  }
}

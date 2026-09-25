import type { AgentConfig, AgentRunResult, InboundEnvelope, ModelConfig, OutboundMessage, ProcessedEventRecord, ToolContext } from "./types.js";
import type { ModelMessage, ModelToolDefinition } from "../ports/model.js";
import { ModelProviderRegistry } from "../ports/model.js";
import type { PlatformStorePort } from "../ports/store.js";
import { ToolRegistry } from "./tool-registry.js";
import { WorkflowRuntime } from "../workflows/runtime.js";

export interface AgentRuntimeOptions {
  defaultModel?: ModelConfig;
}

export class AgentRuntime {
  constructor(
    private readonly store: PlatformStorePort,
    private readonly models: ModelProviderRegistry,
    private readonly tools: ToolRegistry,
    private readonly workflows: WorkflowRuntime,
    private readonly options: AgentRuntimeOptions = {},
  ) {}

  async execute(tenant: AgentConfig, inbound: InboundEnvelope): Promise<AgentRunResult> {
    const state = await this.store.getConversation(tenant.tenantId, inbound.channel, inbound.conversationId, inbound.userId);
    const expectedRevision = state.revision ?? 0;

    if (state.mode === "human") {
      const event: ProcessedEventRecord = {
        externalMessageId: inbound.externalMessageId,
        tenantId: tenant.tenantId,
        channel: inbound.channel,
        configVersion: tenant.configVersion,
        outbound: [],
        processedAt: new Date().toISOString(),
      };
      await this.store.commitTurn(state, expectedRevision, event);
      return { text: "", outbound: [], state, toolCalls: [] };
    }

    let effectiveTenant = tenant;
    if (
      state.workflow?.status === "active" &&
      state.configVersion &&
      tenant.configVersion !== state.configVersion
    ) {
      effectiveTenant = await this.store.getTenantVersion(tenant.tenantId, state.configVersion) ?? tenant;
    }

    let result: { text: string; outbound: OutboundMessage[]; toolCalls: string[] };
    const routedToWorkflow = state.workflow?.status === "active";

    if (routedToWorkflow) {
      result = await this.workflows.handleInput(effectiveTenant, state, inbound.text, inbound.externalMessageId);
    } else {
      result = await this.runAgent(effectiveTenant, state, inbound.text, inbound.externalMessageId);
    }

    const startedWorkflow = result.toolCalls.includes("start_workflow");
    if (!routedToWorkflow && !startedWorkflow) {
      state.messages.push({ role: "user", text: inbound.text, at: inbound.receivedAt });
      if (result.text) state.messages.push({ role: "assistant", text: result.text, at: new Date().toISOString() });
    }

    const processedEvent: ProcessedEventRecord = {
      externalMessageId: inbound.externalMessageId,
      tenantId: effectiveTenant.tenantId,
      channel: inbound.channel,
      configVersion: effectiveTenant.configVersion,
      outbound: result.outbound,
      processedAt: new Date().toISOString(),
    };
    await this.store.commitTurn(state, expectedRevision, processedEvent);
    await this.store.audit(effectiveTenant.tenantId, "agent.response", {
      channel: inbound.channel,
      userId: inbound.userId,
      externalMessageId: inbound.externalMessageId,
      toolCalls: result.toolCalls,
      workflowId: state.workflow?.workflowId,
      workflowStatus: state.workflow?.status,
      configVersion: effectiveTenant.configVersion,
      conversationRevision: state.revision,
    });

    return { text: result.text, outbound: result.outbound, state, toolCalls: result.toolCalls };
  }

  private resolveModel(tenant: AgentConfig): ModelConfig {
    if (tenant.model?.provider && tenant.model.model) return tenant.model;
    if (tenant.modelId) return { provider: "bedrock", model: tenant.modelId };
    if (this.options.defaultModel) return this.options.defaultModel;
    throw new Error(`No model configured for tenant ${tenant.tenantId}.`);
  }

  private async runAgent(
    tenant: AgentConfig,
    state: AgentRunResult["state"],
    userText: string,
    externalMessageId: string,
  ): Promise<{ text: string; outbound: OutboundMessage[]; toolCalls: string[] }> {
    const model = this.resolveModel(tenant);
    const provider = this.models.get(model.provider);
    const agentBindings = this.tools.getAgentBindings(tenant);
    const toolDefinitions: ModelToolDefinition[] = agentBindings.map((binding) => ({
      name: binding.name,
      description: binding.description,
      inputSchema: binding.inputSchema,
    }));

    const workflowCatalog = tenant.workflows ?? [];
    if (workflowCatalog.length > 0) {
      toolDefinitions.push({
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
          type: "object",
          properties: {
            workflowId: { type: "string", enum: workflowCatalog.map((workflow) => workflow.id) },
          },
          required: ["workflowId"],
          additionalProperties: false,
        },
      });
    }

    if (toolDefinitions.length > 0 && !provider.capabilities.toolCalling) {
      throw new Error(`Model provider ${provider.id} does not support tool calling required by tenant ${tenant.tenantId}.`);
    }

    const messages: ModelMessage[] = state.messages.slice(-20).map((message) => ({
      role: message.role,
      content: [{ type: "text", text: message.text }],
    }));
    messages.push({ role: "user", content: [{ type: "text", text: userText }] });

    const toolCalls: string[] = [];
    const maxRounds = tenant.maxToolRounds ?? 6;
    const workflowInstruction = workflowCatalog.length > 0
      ? "\n\nConfigured business workflows are available through start_workflow. Use that tool instead of improvising a transactional flow when the user's intent matches one."
      : "";
    const ctx: ToolContext = { tenant, state, externalMessageId };

    for (let round = 0; round <= maxRounds; round += 1) {
      const response = await provider.generate({
        model,
        system: tenant.systemPrompt + workflowInstruction,
        messages,
        tools: toolDefinitions,
        maxTokens: 1200,
        temperature: 0.2,
      });
      messages.push(response.message);

      if (response.toolCalls.length === 0) {
        const finalText = response.text || "I could not produce a response.";
        return { text: finalText, outbound: [{ kind: "text", text: finalText }], toolCalls };
      }
      if (round === maxRounds) throw new Error(`Maximum tool rounds (${maxRounds}) exceeded.`);

      const workflowUse = response.toolCalls.find((call) => call.name === "start_workflow");
      if (workflowUse) {
        const workflowId = workflowUse.input.workflowId;
        if (typeof workflowId !== "string") throw new Error("start_workflow requires workflowId.");
        toolCalls.push("start_workflow");
        state.configVersion = tenant.configVersion;
        const result = await this.workflows.start(tenant, state, workflowId, externalMessageId);
        return { text: result.text, outbound: result.outbound, toolCalls: [...toolCalls, ...result.toolCalls] };
      }

      const toolResults: ModelMessage["content"] = [];
      for (const use of response.toolCalls) {
        toolCalls.push(use.name);
        const result = await this.tools.executeByName(tenant, use.name, ctx, use.input, "agent");
        toolResults.push({ type: "tool_result", id: use.id, result, isError: !result.ok });
      }
      messages.push({ role: "user", content: toolResults });
    }

    throw new Error("Agent loop ended unexpectedly.");
  }
}

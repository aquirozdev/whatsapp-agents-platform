import type { AgentConfig, AgentRunResult, InboundEnvelope, OutboundMessage } from "./types.js";
import { BedrockAgent } from "../providers/bedrock.js";
import { PlatformStore } from "../storage/dynamo.js";
import { ToolRegistry } from "./tool-registry.js";
import { WorkflowRuntime } from "../workflows/runtime.js";

export class AgentRuntime {
  private readonly agent: BedrockAgent;
  private readonly workflows: WorkflowRuntime;

  constructor(private readonly store: PlatformStore) {
    this.agent = new BedrockAgent(store);
    this.workflows = new WorkflowRuntime(store, new ToolRegistry(store));
  }

  async execute(tenant: AgentConfig, inbound: InboundEnvelope): Promise<AgentRunResult> {
    const state = await this.store.getConversation(tenant.tenantId, inbound.channel, inbound.conversationId, inbound.userId);

    if (state.mode === "human") {
      return { text: "", outbound: [], state, toolCalls: [] };
    }

    let result: { text: string; outbound: OutboundMessage[]; toolCalls: string[] };
    const routedToWorkflow = state.workflow?.status === "active";

    if (routedToWorkflow) {
      result = await this.workflows.handleInput(tenant, state, inbound.text, inbound.externalMessageId);
    } else {
      result = await this.agent.run(tenant, state, inbound.text, inbound.externalMessageId);
    }

    // Transactional workflow turns can contain identification values, OTPs and
    // account selections. Keep them out of free-form LLM history.
    const startedWorkflow = result.toolCalls.includes("start_workflow");
    if (!routedToWorkflow && !startedWorkflow) {
      state.messages.push({ role: "user", text: inbound.text, at: inbound.receivedAt });
      if (result.text) state.messages.push({ role: "assistant", text: result.text, at: new Date().toISOString() });
    }

    await this.store.saveConversation(state);
    await this.store.audit(tenant.tenantId, "agent.response", {
      channel: inbound.channel,
      userId: inbound.userId,
      externalMessageId: inbound.externalMessageId,
      toolCalls: result.toolCalls,
      workflowId: state.workflow?.workflowId,
      workflowStatus: state.workflow?.status,
    });

    return { text: result.text, outbound: result.outbound, state, toolCalls: result.toolCalls };
  }
}

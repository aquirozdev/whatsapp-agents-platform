import type { AgentConfig, InboundEnvelope, OutboundMessage } from "../core/types.js";

export interface ChannelInboundMessage {
  routingKey: string;
  userId: string;
  conversationId: string;
  externalMessageId: string;
  text: string;
  receivedAt: string;
  replyTarget?: { value: string; kind?: string };
  metadata?: Record<string, unknown>;
}

export interface ChannelAdapter {
  readonly id: string;
  parseInbound(rawBody: string): ChannelInboundMessage[];
  toEnvelope(tenant: AgentConfig, message: ChannelInboundMessage): InboundEnvelope;
  send(tenant: AgentConfig, target: { value: string; kind?: string }, message: OutboundMessage): Promise<void>;
}

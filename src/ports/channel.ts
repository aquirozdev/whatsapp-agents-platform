import type { AgentConfig, ChannelDeliveryReceipt, ChannelDeliveryStatus, InboundContent, InboundEnvelope, OutboundMessage } from "../core/types.js";

export interface ChannelInboundMessage {
  routingKey: string;
  userId: string;
  conversationId: string;
  externalMessageId: string;
  text: string;
  content?: InboundContent[];
  receivedAt: string;
  replyTarget?: { value: string; kind?: string };
  metadata?: Record<string, unknown>;
}

export interface ChannelCapabilities {
  text: boolean;
  images: boolean;
  documents: boolean;
  audio: boolean;
  templates: boolean;
  buttons: boolean;
  lists: boolean;
}

export interface ChannelAdapter {
  readonly id: string;
  readonly capabilities: ChannelCapabilities;
  parseInbound(rawBody: string): ChannelInboundMessage[];
  parseDeliveryStatuses?(rawBody: string): ChannelDeliveryStatus[];
  toEnvelope(tenant: AgentConfig, message: ChannelInboundMessage): InboundEnvelope;
  send(tenant: AgentConfig, target: { value: string; kind?: string }, message: OutboundMessage): Promise<ChannelDeliveryReceipt>;
}

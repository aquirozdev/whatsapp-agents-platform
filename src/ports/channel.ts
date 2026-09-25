import type { AgentConfig, InboundEnvelope, OutboundMessage } from "../core/types.js";

export interface OutboundChannel {
  readonly id: string;
  send(tenant: AgentConfig, inbound: InboundEnvelope, messages: OutboundMessage[]): Promise<void>;
}

export interface ChannelRegistry {
  resolve(channel: string): OutboundChannel | undefined;
}

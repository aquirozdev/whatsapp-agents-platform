import type { AgentConfig, ConsentRecord, ConversationState, OtpChallenge } from "../core/types.js";

export class ConversationConflictError extends Error {
  constructor() {
    super("Conversation state changed concurrently.");
    this.name = "ConversationConflictError";
  }
}

export class ConversationBusyError extends Error {
  constructor() {
    super("Conversation is already being processed.");
    this.name = "ConversationBusyError";
  }
}

export interface PlatformStorePort {
  getTenant(tenantId: string): Promise<AgentConfig | undefined>;
  getTenantVersion(tenantId: string, version: number): Promise<AgentConfig | undefined>;
  getTenantByWhatsAppPhoneNumberId(phoneNumberId: string): Promise<AgentConfig | undefined>;
  putTenant(config: AgentConfig): Promise<number>;

  getConversation(tenantId: string, channel: string, conversationId: string, userId: string): Promise<ConversationState>;
  saveConversation(state: ConversationState, expectedRevision?: number): Promise<void>;
  setConversationMode(tenantId: string, channel: string, conversationId: string, mode: "ai" | "human"): Promise<void>;
  acquireConversationLease(tenantId: string, channel: string, conversationId: string, owner: string, leaseSeconds?: number): Promise<boolean>;
  releaseConversationLease(tenantId: string, channel: string, conversationId: string, owner: string): Promise<void>;

  isEventProcessed(externalMessageId: string): Promise<boolean>;
  markEventProcessed(externalMessageId: string, ttlSeconds?: number): Promise<void>;

  claimOtpRequestSlot(tenantId: string, userId: string, cooldownSeconds: number): Promise<boolean>;
  putOtpChallenge(challenge: OtpChallenge): Promise<void>;
  getOtpChallenge(tenantId: string, challengeId: string): Promise<OtpChallenge | undefined>;
  consumeOtpChallenge(tenantId: string, challengeId: string, consumedAt: string): Promise<boolean>;
  incrementOtpAttempt(tenantId: string, challengeId: string): Promise<void>;

  hasConsent(tenantId: string, subjectId: string, policyId: string, version?: string): Promise<boolean>;
  recordConsent(record: ConsentRecord): Promise<void>;

  audit(tenantId: string, action: string, data: Record<string, unknown>): Promise<void>;
}

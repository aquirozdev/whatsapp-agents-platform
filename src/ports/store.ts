import type {
  AgentConfig,
  ConsentRecord,
  ConversationState,
  OtpChallenge,
} from "../core/types.js";

export interface PlatformStorePort {
  getTenant(tenantId: string): Promise<AgentConfig | undefined>;
  getTenantVersion(tenantId: string, version: string): Promise<AgentConfig | undefined>;
  getTenantByWhatsAppPhoneNumberId(phoneNumberId: string): Promise<AgentConfig | undefined>;
  putTenant(config: AgentConfig): Promise<void>;

  getConversation(tenantId: string, channel: string, conversationId: string, userId: string): Promise<ConversationState>;
  saveConversation(state: ConversationState): Promise<void>;
  setConversationMode(tenantId: string, channel: string, conversationId: string, mode: "ai" | "human"): Promise<void>;

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

export type ChannelKind = "whatsapp" | "web" | (string & {});
export type ConversationMode = "ai" | "human";
export type VerificationLevel = "none" | "otp";
export type ToolExposure = "agent" | "workflow" | "both";
export const CURRENT_SCHEMA_VERSION = 1;

export type ToolErrorCategory = "validation" | "auth" | "rate_limit" | "timeout" | "upstream" | "business" | "internal";
export type DeliveryStatus = "accepted" | "sent" | "delivered" | "read" | "failed";

export interface SecretRef {
  key: string;
}

export interface ModelConfig {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKeySecret?: SecretRef;
  maxTokens?: number;
  temperature?: number;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  items?: JsonSchema;
  description?: string;
}

export interface ConsentRequirement {
  policyId: string;
  version?: string;
  subjectFrom?: string;
}

export interface HttpToolConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  secretHeaders?: Record<string, string | SecretRef>;
  bodyTemplate?: unknown;
  timeoutMs?: number;
  idempotencyHeader?: string;
  allowedHosts?: string[];
  allowInsecureHttp?: boolean;
  maxResponseBytes?: number;
  responsePath?: string;
  retry?: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    retryOn?: Array<"timeout" | "rate_limit" | "5xx">;
  };
}

export interface ToolBinding {
  name: string;
  kind: "builtin" | "http" | (string & {});
  description: string;
  inputSchema: JsonSchema;
  exposure?: ToolExposure;
  requiresVerification?: VerificationLevel;
  verificationSubjectFrom?: string;
  requiresConsents?: ConsentRequirement[];
  http?: HttpToolConfig;
  rateLimit?: {
    maxCalls: number;
    windowSeconds: number;
    scope?: "tenant" | "user" | "conversation";
  };
  config?: Record<string, unknown>;
}

export interface WhatsAppChannelConfig {
  phoneNumberId: string;
  accessTokenSecret?: SecretRef;
  /** @deprecated Prefer accessTokenSecret for provider-neutral tenant specs. */
  accessTokenSecretArn?: string;
  graphApiVersion: string;
  sendTimeoutMs?: number;
}

export interface OtpConfig {
  enabled: boolean;
  codeTtlSeconds?: number;
  sessionTtlSeconds?: number;
  maxAttempts?: number;
  requestCooldownSeconds?: number;
  allowedChannels?: Array<"sms" | "email">;
}

export interface CapabilityDefinition {
  id: string;
  name: string;
  description?: string;
  tools?: string[];
  workflows?: string[];
}

export interface WorkflowCollectStep {
  id: string;
  type: "collect";
  field: string;
  prompt: string;
  transform?: "trim" | "digits";
  validation?: { regex?: string; minLength?: number; maxLength?: number };
  errorMessage?: string;
}

export interface WorkflowToolStep {
  id: string;
  type: "tool";
  tool: string;
  input?: unknown;
  saveAs?: string;
  onErrorMessage?: string;
}

export interface WorkflowSelectOption {
  value: string | number | boolean;
  label: string;
}

export interface WorkflowSelectStep {
  id: string;
  type: "select";
  field: string;
  prompt: string;
  options?: WorkflowSelectOption[];
  source?: string;
  filter?: { path: string; equals: unknown };
  valuePath?: string;
  labelPath?: string;
  store?: "value" | "item";
  autoSelectSingle?: boolean;
  emptyMessage?: string;
  invalidMessage?: string;
}

export interface WorkflowConfirmStep {
  id: string;
  type: "confirm";
  field: string;
  prompt: string;
  yesValues?: string[];
  noValues?: string[];
  invalidMessage?: string;
  rejectMessage?: string;
  onReject?: "cancel" | "continue";
}

export interface WorkflowConsentStep {
  id: string;
  type: "consent";
  policyId: string;
  version?: string;
  prompt: string;
  documentUrl?: string;
  subjectFrom?: string;
  yesValues?: string[];
  noValues?: string[];
  invalidMessage?: string;
  rejectMessage?: string;
}

export interface WorkflowVerificationStep {
  id: string;
  type: "verification";
  startTool: string;
  startInput?: unknown;
  verifyTool: string;
  verifyInput?: unknown;
  successPath?: string;
  prompt: string;
  invalidMessage?: string;
  terminalErrorCodes?: string[];
  terminalMessage?: string;
  sessionTtlSeconds?: number;
  skipIfVerified?: boolean;
  subjectFrom?: string;
}

export interface WorkflowBranchStep {
  id: string;
  type: "branch";
  path: string;
  cases: Record<string, string>;
  default?: string;
}

export interface WorkflowRenderStep {
  id: string;
  type: "render";
  template: string;
}

export interface WorkflowRenderListStep {
  id: string;
  type: "render_list";
  source: string;
  header?: string;
  itemTemplate: string;
  emptyMessage?: string;
  maxItems?: number;
}

export interface WorkflowDeliverStep {
  id: string;
  type: "deliver";
  kind: "document";
  urlFrom: string;
  filenameFrom?: string;
  caption?: string;
}

export interface WorkflowMessageStep {
  id: string;
  type: "message";
  message: OutboundMessage;
}

export interface WorkflowEndStep {
  id: string;
  type: "end";
  message?: string;
}

export type WorkflowStep =
  | WorkflowCollectStep
  | WorkflowToolStep
  | WorkflowSelectStep
  | WorkflowConfirmStep
  | WorkflowConsentStep
  | WorkflowVerificationStep
  | WorkflowBranchStep
  | WorkflowRenderStep
  | WorkflowRenderListStep
  | WorkflowDeliverStep
  | WorkflowMessageStep
  | WorkflowEndStep;

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  triggerExamples?: string[];
  sessionTtlSeconds?: number;
  retainDataOnCompletion?: boolean;
  cancelWords?: string[];
  cancelMessage?: string;
  sessionExpiredMessage?: string;
  steps: WorkflowStep[];
}

export interface WorkflowAwaiting {
  stepId: string;
  kind: "collect" | "select" | "confirm" | "consent" | "verification";
}

export interface WorkflowState {
  workflowId: string;
  stepIndex: number;
  status: "active" | "completed" | "cancelled" | "expired";
  data: Record<string, unknown>;
  awaiting?: WorkflowAwaiting;
  startedAt: string;
  updatedAt: string;
  expiresAt?: number;
}

export interface AgentConfig {
  schemaVersion?: number;
  tenantId: string;
  displayName: string;
  enabled: boolean;
  systemPrompt: string;
  model?: ModelConfig;
  /** @deprecated Kept for backwards compatibility. Prefer model.provider + model.model. */
  modelId?: string;
  configVersion?: number;
  maxToolRounds?: number;
  apiKeyHash?: string;
  whatsapp?: WhatsAppChannelConfig;
  otp?: OtpConfig;
  tools: ToolBinding[];
  workflows?: WorkflowDefinition[];
  capabilities?: CapabilityDefinition[];
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface VerificationState {
  level: VerificationLevel;
  verifiedAt?: string;
  expiresAt?: number;
  subjectId?: string;
}

export interface ConversationState {
  tenantId: string;
  channel: ChannelKind;
  conversationId: string;
  userId: string;
  mode: ConversationMode;
  messages: ChatMessage[];
  verification: VerificationState;
  workflow?: WorkflowState;
  configVersion?: number;
  revision?: number;
  updatedAt: string;
}

export type InboundContent =
  | { kind: "text"; text: string }
  | { kind: "image"; url?: string; mediaId?: string; caption?: string; mimeType?: string }
  | { kind: "audio"; url?: string; mediaId?: string; mimeType?: string }
  | { kind: "document"; url?: string; mediaId?: string; filename?: string; caption?: string; mimeType?: string }
  | { kind: "location"; latitude: number; longitude: number; name?: string; address?: string }
  | { kind: "interactive_reply"; id?: string; title: string; replyType: "button" | "list" };

export interface InboundEnvelope {
  tenantId: string;
  channel: ChannelKind;
  conversationId: string;
  userId: string;
  /** Compatibility projection for the conversational runtime. */
  text: string;
  content?: InboundContent[];
  externalMessageId: string;
  receivedAt: string;
  replyTarget?: { value: string; kind?: string };
  /** @deprecated Prefer replyTarget. */
  replyTo?: string;
  /** @deprecated Prefer replyTarget.kind. */
  replyToType?: "phone" | "whatsapp_user_id";
  metadata?: Record<string, unknown>;
}

export type OutboundMessage =
  | { kind: "text"; text: string }
  | { kind: "document"; url: string; filename?: string; caption?: string }
  | { kind: "image"; url: string; caption?: string }
  | { kind: "interactive"; body: string; buttons?: Array<{ id: string; title: string }>; list?: { buttonText: string; sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }> } }
  | { kind: "template"; name: string; languageCode: string; components?: unknown[] };

export interface ChannelDeliveryReceipt {
  providerMessageId?: string;
  acceptedAt: string;
  status: DeliveryStatus;
  metadata?: Record<string, unknown>;
}

export interface ChannelDeliveryStatus {
  providerMessageId: string;
  status: DeliveryStatus;
  occurredAt: string;
  errorCode?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentRunResult {
  text: string;
  outbound: OutboundMessage[];
  state: ConversationState;
  toolCalls: string[];
}

export interface ToolContext {
  tenant: AgentConfig;
  state: ConversationState;
  externalMessageId: string;
}

export interface ToolExecutionResult {
  ok: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    category?: ToolErrorCategory;
  };
  metadata?: {
    upstreamRequestId?: string;
    latencyMs?: number;
    attempts?: number;
    statusCode?: number;
  };
}

export interface OtpChallenge {
  tenantId: string;
  challengeId: string;
  conversationId: string;
  userId: string;
  subjectId: string;
  codeHash: string;
  destinationMasked: string;
  channel: "sms" | "email";
  attempts: number;
  maxAttempts: number;
  expiresAt: number;
  createdAt: string;
  consumedAt?: string;
}

export interface ConsentRecord {
  tenantId: string;
  subjectId: string;
  policyId: string;
  version: string;
  acceptedAt: string;
  channel: ChannelKind;
  conversationId: string;
}


export interface ProcessedEventRecord {
  externalMessageId: string;
  tenantId: string;
  channel: ChannelKind;
  configVersion?: number;
  outbound: OutboundMessage[];
  processedAt: string;
  deliveredAt?: string;
  deliveries?: ChannelDeliveryReceipt[];
  expiresAt?: number;
}

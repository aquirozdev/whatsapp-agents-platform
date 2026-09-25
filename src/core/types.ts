export type ChannelKind = "whatsapp" | "web";
export type ConversationMode = "ai" | "human";
export type VerificationLevel = "none" | "otp";
export type ToolExposure = "agent" | "workflow" | "both";

export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  enum?: unknown[];
  [key: string]: unknown;
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
  secretHeaders?: Record<string, string>;
  bodyTemplate?: unknown;
  timeoutMs?: number;
  idempotencyHeader?: string;
  allowedHosts?: string[];
  allowInsecureHttp?: boolean;
  maxResponseBytes?: number;
  responsePath?: string;
}

export interface ToolBinding {
  name: string;
  kind: "builtin" | "http";
  description: string;
  inputSchema: JsonSchema;
  exposure?: ToolExposure;
  requiresVerification?: VerificationLevel;
  verificationSubjectFrom?: string;
  requiresConsents?: ConsentRequirement[];
  http?: HttpToolConfig;
}

export interface WhatsAppChannelConfig {
  phoneNumberId: string;
  accessTokenSecretArn: string;
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
  tenantId: string;
  displayName: string;
  enabled: boolean;
  systemPrompt: string;
  modelId?: string;
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
  updatedAt: string;
}

export interface InboundEnvelope {
  tenantId: string;
  channel: ChannelKind;
  conversationId: string;
  userId: string;
  text: string;
  externalMessageId: string;
  receivedAt: string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export type OutboundMessage =
  | { kind: "text"; text: string }
  | { kind: "document"; url: string; filename?: string; caption?: string };

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
  error?: { code: string; message: string };
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

import { CURRENT_SCHEMA_VERSION, type AgentConfig, type ToolBinding, type WorkflowStep } from "./types.js";

export interface ConfigIssue { path: string; message: string; }

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const WORKFLOW_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const RESERVED_TOOLS = new Set(["start_workflow"]);
const TENANT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_CONFIG_BYTES = 300 * 1024;

export function validateAgentConfig(config: AgentConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (config.schemaVersion !== undefined && (!Number.isInteger(config.schemaVersion) || config.schemaVersion < 1 || config.schemaVersion > CURRENT_SCHEMA_VERSION)) {
    issues.push({ path: "schemaVersion", message: `schemaVersion must be an integer between 1 and ${CURRENT_SCHEMA_VERSION}.` });
  }
  if (!config.tenantId?.trim()) issues.push({ path: "tenantId", message: "tenantId is required." });
  else if (!TENANT_ID.test(config.tenantId)) issues.push({ path: "tenantId", message: "tenantId must match [a-z0-9][a-z0-9_-]{0,63}." });
  if (!config.displayName?.trim()) issues.push({ path: "displayName", message: "displayName is required." });
  else if (config.displayName.length > 120) issues.push({ path: "displayName", message: "displayName must be at most 120 characters." });
  if (!config.systemPrompt?.trim()) issues.push({ path: "systemPrompt", message: "systemPrompt is required." });
  else if (config.systemPrompt.length > 20000) issues.push({ path: "systemPrompt", message: "systemPrompt must be at most 20000 characters." });
  if (config.model) {
    if (!config.model.provider?.trim()) issues.push({ path: "model.provider", message: "model.provider is required when model is configured." });
    if (!config.model.model?.trim()) issues.push({ path: "model.model", message: "model.model is required when model is configured." });
    if (config.model.baseUrl) {
      try {
        const parsed = new URL(config.model.baseUrl);
        if (parsed.protocol !== "https:") issues.push({ path: "model.baseUrl", message: "model.baseUrl must use HTTPS." });
      } catch {
        issues.push({ path: "model.baseUrl", message: "model.baseUrl is invalid." });
      }
    }
    if (config.model.apiKeySecret && !config.model.apiKeySecret.key?.trim()) {
      issues.push({ path: "model.apiKeySecret.key", message: "model.apiKeySecret.key is required." });
    }
    if (config.model.maxTokens !== undefined && (!Number.isInteger(config.model.maxTokens) || config.model.maxTokens < 1 || config.model.maxTokens > 100000)) {
      issues.push({ path: "model.maxTokens", message: "model.maxTokens must be an integer between 1 and 100000." });
    }
    if (config.model.temperature !== undefined && (config.model.temperature < 0 || config.model.temperature > 2)) {
      issues.push({ path: "model.temperature", message: "model.temperature must be between 0 and 2." });
    }
  }

  const configBytes = Buffer.byteLength(JSON.stringify(config), "utf8");
  if (configBytes > MAX_CONFIG_BYTES) {
    issues.push({ path: "$", message: `Tenant configuration is ${configBytes} bytes; keep it at or below ${MAX_CONFIG_BYTES} bytes.` });
  }
  validateWhatsApp(config, issues);
  validateOtp(config, issues);

  const tools = new Map<string, ToolBinding>();
  for (const [i, tool] of (config.tools ?? []).entries()) {
    const path = `tools[${i}]`;
    if (!TOOL_NAME.test(tool.name)) issues.push({ path: `${path}.name`, message: "Tool name must match [a-zA-Z0-9_-]{1,64}." });
    if (RESERVED_TOOLS.has(tool.name)) issues.push({ path: `${path}.name`, message: `${tool.name} is reserved by the platform.` });
    if (tools.has(tool.name)) issues.push({ path: `${path}.name`, message: "Tool names must be unique." });
    tools.set(tool.name, tool);
    validatePortableSchema(tool.inputSchema, `${path}.inputSchema`, issues);
    if (tool.verificationSubjectFrom && (tool.requiresVerification ?? "none") === "none") {
      issues.push({ path: `${path}.verificationSubjectFrom`, message: "verificationSubjectFrom requires requiresVerification." });
    }
    if (tool.rateLimit) {
      if (!Number.isInteger(tool.rateLimit.maxCalls) || tool.rateLimit.maxCalls < 1 || tool.rateLimit.maxCalls > 100000) {
        issues.push({ path: `${path}.rateLimit.maxCalls`, message: "maxCalls must be an integer between 1 and 100000." });
      }
      if (!Number.isInteger(tool.rateLimit.windowSeconds) || tool.rateLimit.windowSeconds < 1 || tool.rateLimit.windowSeconds > 86400) {
        issues.push({ path: `${path}.rateLimit.windowSeconds`, message: "windowSeconds must be an integer between 1 and 86400." });
      }
    }
    if (tool.kind === "http") {
      if (!tool.http) issues.push({ path: `${path}.http`, message: "HTTP tools require http configuration." });
      else validateHttp(tool, path, issues);
    }
  }

  const workflowIds = new Set<string>();
  for (const [wi, workflow] of (config.workflows ?? []).entries()) {
    const base = `workflows[${wi}]`;
    if (!WORKFLOW_ID.test(workflow.id)) issues.push({ path: `${base}.id`, message: "Workflow id must match [a-zA-Z0-9_-]{1,64}." });
    if (workflowIds.has(workflow.id)) issues.push({ path: `${base}.id`, message: "Workflow IDs must be unique." });
    workflowIds.add(workflow.id);
    if (!workflow.steps.length) issues.push({ path: `${base}.steps`, message: "Workflow must contain at least one step." });

    const stepIds = new Set<string>();
    for (const [si, step] of workflow.steps.entries()) {
      if (!step.id?.trim()) issues.push({ path: `${base}.steps[${si}].id`, message: "Step id is required." });
      if (stepIds.has(step.id)) issues.push({ path: `${base}.steps[${si}].id`, message: "Workflow step IDs must be unique." });
      stepIds.add(step.id);
    }
    for (const [si, step] of workflow.steps.entries()) validateStep(step, `${base}.steps[${si}]`, stepIds, tools, issues);
  }

  const capabilityIds = new Set<string>();
  for (const [i, capability] of (config.capabilities ?? []).entries()) {
    const base = `capabilities[${i}]`;
    if (capabilityIds.has(capability.id)) issues.push({ path: `${base}.id`, message: "Capability IDs must be unique." });
    capabilityIds.add(capability.id);
    for (const tool of capability.tools ?? []) if (!tools.has(tool)) issues.push({ path: `${base}.tools`, message: `Unknown tool reference: ${tool}.` });
    for (const workflow of capability.workflows ?? []) if (!workflowIds.has(workflow)) issues.push({ path: `${base}.workflows`, message: `Unknown workflow reference: ${workflow}.` });
  }
  return issues;
}

function validateWhatsApp(config: AgentConfig, issues: ConfigIssue[]): void {
  const whatsapp = config.whatsapp;
  if (!whatsapp) return;
  if (!/^\d{5,32}$/.test(whatsapp.phoneNumberId)) {
    issues.push({ path: "whatsapp.phoneNumberId", message: "WhatsApp phoneNumberId must be a numeric Meta phone number ID." });
  }
  if (!/^v\d+\.\d+$/.test(whatsapp.graphApiVersion)) {
    issues.push({ path: "whatsapp.graphApiVersion", message: "graphApiVersion must look like v23.0." });
  }
  const portableSecret = whatsapp.accessTokenSecret?.key?.trim();
  const legacySecret = whatsapp.accessTokenSecretArn?.trim();
  if (!portableSecret && !legacySecret) {
    issues.push({ path: "whatsapp.accessTokenSecret", message: "WhatsApp access token secret reference is required." });
  }
  if (whatsapp.sendTimeoutMs !== undefined && (whatsapp.sendTimeoutMs < 1000 || whatsapp.sendTimeoutMs > 30000)) {
    issues.push({ path: "whatsapp.sendTimeoutMs", message: "sendTimeoutMs must be between 1000 and 30000 milliseconds." });
  }
}

function validateOtp(config: AgentConfig, issues: ConfigIssue[]): void {
  const otp = config.otp;
  if (!otp) return;
  if (otp.codeTtlSeconds !== undefined && (otp.codeTtlSeconds < 30 || otp.codeTtlSeconds > 900)) {
    issues.push({ path: "otp.codeTtlSeconds", message: "codeTtlSeconds must be between 30 and 900." });
  }
  if (otp.sessionTtlSeconds !== undefined && (otp.sessionTtlSeconds < 60 || otp.sessionTtlSeconds > 86400)) {
    issues.push({ path: "otp.sessionTtlSeconds", message: "sessionTtlSeconds must be between 60 and 86400." });
  }
  if (otp.maxAttempts !== undefined && (!Number.isInteger(otp.maxAttempts) || otp.maxAttempts < 1 || otp.maxAttempts > 10)) {
    issues.push({ path: "otp.maxAttempts", message: "maxAttempts must be an integer between 1 and 10." });
  }
  if (otp.requestCooldownSeconds !== undefined && (otp.requestCooldownSeconds < 0 || otp.requestCooldownSeconds > 3600)) {
    issues.push({ path: "otp.requestCooldownSeconds", message: "requestCooldownSeconds must be between 0 and 3600." });
  }
}

function validateHttp(tool: ToolBinding, path: string, issues: ConfigIssue[]): void {
  const http = tool.http!;
  const marker = http.url.indexOf("://");
  const slash = marker < 0 ? -1 : http.url.indexOf("/", marker + 3);
  const origin = marker < 0 ? http.url : slash < 0 ? http.url : http.url.slice(0, slash);
  if (origin.includes("{{")) {
    issues.push({ path: `${path}.http.url`, message: "Dynamic HTTP origins are forbidden; templates may appear only in path/query." });
    return;
  }
  try {
    const parsed = new URL(http.url.replace(/{{\s*[\w.]+\s*}}/g, "placeholder"));
    if (parsed.protocol !== "https:" && !(http.allowInsecureHttp && parsed.protocol === "http:")) {
      issues.push({ path: `${path}.http.url`, message: "HTTP tools must use HTTPS unless allowInsecureHttp is enabled." });
    }
    if (http.allowedHosts?.length && !http.allowedHosts.includes(parsed.hostname)) {
      issues.push({ path: `${path}.http.allowedHosts`, message: `Configured URL host ${parsed.hostname} is not allowlisted.` });
    }
  } catch {
    issues.push({ path: `${path}.http.url`, message: "HTTP tool URL is invalid." });
  }
  if (http.timeoutMs !== undefined && (http.timeoutMs < 100 || http.timeoutMs > 60000)) {
    issues.push({ path: `${path}.http.timeoutMs`, message: "timeoutMs must be between 100 and 60000 milliseconds." });
  }
  if (http.maxResponseBytes !== undefined && (http.maxResponseBytes <= 0 || http.maxResponseBytes > 5 * 1024 * 1024)) {
    issues.push({ path: `${path}.http.maxResponseBytes`, message: "maxResponseBytes must be greater than zero and at most 5 MiB." });
  }
  if (http.retry) {
    if (http.retry.maxAttempts !== undefined && (!Number.isInteger(http.retry.maxAttempts) || http.retry.maxAttempts < 1 || http.retry.maxAttempts > 4)) {
      issues.push({ path: `${path}.http.retry.maxAttempts`, message: "maxAttempts must be an integer between 1 and 4." });
    }
    if (http.retry.baseDelayMs !== undefined && (http.retry.baseDelayMs < 25 || http.retry.baseDelayMs > 10000)) {
      issues.push({ path: `${path}.http.retry.baseDelayMs`, message: "baseDelayMs must be between 25 and 10000." });
    }
    if (http.retry.maxDelayMs !== undefined && (http.retry.maxDelayMs < 25 || http.retry.maxDelayMs > 30000)) {
      issues.push({ path: `${path}.http.retry.maxDelayMs`, message: "maxDelayMs must be between 25 and 30000." });
    }
    if ((http.retry.maxAttempts ?? 1) > 1 && !["GET", "DELETE"].includes(http.method) && !http.idempotencyHeader) {
      issues.push({ path: `${path}.http.retry`, message: "Retries for side-effecting HTTP methods require idempotencyHeader." });
    }
  }
  for (const [header, ref] of Object.entries(http.secretHeaders ?? {})) {
    const key = typeof ref === "string" ? ref.trim() : ref?.key?.trim();
    if (!key) issues.push({ path: `${path}.http.secretHeaders.${header}`, message: "Secret header reference must be a non-empty string or { key }." });
  }
}

function validateStep(step: WorkflowStep, path: string, stepIds: Set<string>, tools: Map<string, ToolBinding>, issues: ConfigIssue[]): void {
  if (step.type === "tool") validateWorkflowTool(step.tool, `${path}.tool`, tools, issues);
  if (step.type === "verification") {
    validateWorkflowTool(step.startTool, `${path}.startTool`, tools, issues);
    validateWorkflowTool(step.verifyTool, `${path}.verifyTool`, tools, issues);
  }
  if (step.type === "branch") {
    for (const target of Object.values(step.cases)) if (!stepIds.has(target)) issues.push({ path: `${path}.cases`, message: `Unknown branch target: ${target}.` });
    if (step.default && !stepIds.has(step.default)) issues.push({ path: `${path}.default`, message: `Unknown branch target: ${step.default}.` });
  }
  if (step.type === "select") {
    if (!step.options && !step.source) issues.push({ path, message: "Select step requires options or source." });
    if (step.options && step.source) issues.push({ path, message: "Select step must use either options or source, not both." });
    if (step.filter && !step.source) issues.push({ path: `${path}.filter`, message: "Selection filters require source." });
  }
  if (step.type === "collect" && step.validation?.regex) {
    try { new RegExp(step.validation.regex); } catch { issues.push({ path: `${path}.validation.regex`, message: "Invalid regular expression." }); }
  }
}

function validateWorkflowTool(name: string, path: string, tools: Map<string, ToolBinding>, issues: ConfigIssue[]): void {
  const tool = tools.get(name);
  if (!tool) return void issues.push({ path, message: `Unknown tool reference: ${name}.` });
  if (tool.exposure === "agent") issues.push({ path, message: `Tool ${name} is agent-only but referenced by a workflow.` });
}

const PORTABLE_SCHEMA_KEYS = new Set([
  "type", "properties", "required", "additionalProperties", "enum", "items", "description",
]);

function validatePortableSchema(schema: unknown, path: string, issues: ConfigIssue[]): void {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const record = schema as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PORTABLE_SCHEMA_KEYS.has(key)) {
      issues.push({ path: `${path}.${key}`, message: `Schema keyword "${key}" is outside the portable tool-schema subset.` });
    }
  }
  if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    for (const [key, value] of Object.entries(record.properties as Record<string, unknown>)) {
      validatePortableSchema(value, `${path}.properties.${key}`, issues);
    }
  }
  validatePortableSchema(record.items, `${path}.items`, issues);
}

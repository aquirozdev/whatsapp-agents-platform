import type { AgentConfig, ToolBinding, WorkflowStep } from "./types.js";

export interface ConfigIssue { path: string; message: string; }

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const WORKFLOW_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const RESERVED_TOOLS = new Set(["start_workflow"]);

export function validateAgentConfig(config: AgentConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (!config.tenantId?.trim()) issues.push({ path: "tenantId", message: "tenantId is required." });
  if (!config.displayName?.trim()) issues.push({ path: "displayName", message: "displayName is required." });
  if (!config.systemPrompt?.trim()) issues.push({ path: "systemPrompt", message: "systemPrompt is required." });
  validateWhatsApp(config, issues);
  validateOtp(config, issues);

  const tools = new Map<string, ToolBinding>();
  for (const [i, tool] of (config.tools ?? []).entries()) {
    const path = `tools[${i}]`;
    if (!TOOL_NAME.test(tool.name)) issues.push({ path: `${path}.name`, message: "Tool name must match [a-zA-Z0-9_-]{1,64}." });
    if (RESERVED_TOOLS.has(tool.name)) issues.push({ path: `${path}.name`, message: `${tool.name} is reserved by the platform.` });
    if (tools.has(tool.name)) issues.push({ path: `${path}.name`, message: "Tool names must be unique." });
    tools.set(tool.name, tool);
    if (tool.verificationSubjectFrom && (tool.requiresVerification ?? "none") === "none") {
      issues.push({ path: `${path}.verificationSubjectFrom`, message: "verificationSubjectFrom requires requiresVerification." });
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
  if (!whatsapp.accessTokenSecretArn?.trim()) {
    issues.push({ path: "whatsapp.accessTokenSecretArn", message: "WhatsApp access token secret ARN is required." });
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

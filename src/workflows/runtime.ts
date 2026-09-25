import type { AgentConfig, ConsentRecord, ConversationState, OutboundMessage, ToolContext, WorkflowDefinition, WorkflowSelectOption, WorkflowSelectStep, WorkflowState, WorkflowStep } from "../core/types.js";
import { getPath, normalizeAnswer, renderTemplate, renderValue, setPath } from "../core/template.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { PlatformStore } from "../storage/dynamo.js";

export interface WorkflowTurnResult { text: string; outbound: OutboundMessage[]; toolCalls: string[]; }
interface SelectionCandidate { value: unknown; label: string; item: unknown; }

export class WorkflowRuntime {
  constructor(private readonly store: PlatformStore, private readonly tools: ToolRegistry) {}

  async start(tenant: AgentConfig, state: ConversationState, workflowId: string, externalMessageId: string): Promise<WorkflowTurnResult> {
    const definition = this.getDefinition(tenant, workflowId);
    const now = Math.floor(Date.now() / 1000);
    state.workflow = {
      workflowId, stepIndex: 0, status: "active", data: {},
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      expiresAt: definition.sessionTtlSeconds ? now + definition.sessionTtlSeconds : undefined,
    };
    await this.store.audit(tenant.tenantId, "workflow.started", { workflowId, userId: state.userId, conversationId: state.conversationId });
    return this.advance(tenant, state, definition, externalMessageId);
  }

  async handleInput(tenant: AgentConfig, state: ConversationState, input: string, externalMessageId: string): Promise<WorkflowTurnResult> {
    const workflow = state.workflow;
    if (!workflow || workflow.status !== "active") throw new Error("No active workflow.");
    const definition = this.getDefinition(tenant, workflow.workflowId);
    const now = Math.floor(Date.now() / 1000);

    if (workflow.expiresAt && workflow.expiresAt <= now) {
      workflow.status = "expired"; workflow.awaiting = undefined; this.clearTerminalData(definition, workflow);
      await this.store.audit(tenant.tenantId, "workflow.expired", { workflowId: workflow.workflowId, userId: state.userId });
      return this.textResult(definition.sessionExpiredMessage ?? "La sesión del proceso expiró. Inicia nuevamente cuando desees.");
    }

    const normalized = normalizeAnswer(input);
    const cancelWords = (definition.cancelWords ?? ["cancelar", "cancel", "salir"]).map(normalizeAnswer);
    if (cancelWords.includes(normalized)) {
      workflow.status = "cancelled"; workflow.awaiting = undefined; this.clearTerminalData(definition, workflow);
      await this.store.audit(tenant.tenantId, "workflow.cancelled", { workflowId: workflow.workflowId, userId: state.userId, reason: "user_cancelled" });
      return this.textResult(definition.cancelMessage ?? "Proceso cancelado.");
    }

    if (!workflow.awaiting) return this.advance(tenant, state, definition, externalMessageId);
    const step = definition.steps[workflow.stepIndex];
    if (!step || step.id !== workflow.awaiting.stepId) throw new Error("Workflow state does not match its awaiting step.");
    const handled = await this.consumeInput(tenant, state, definition, step, input, externalMessageId);
    if (handled) return handled;
    return this.advance(tenant, state, definition, externalMessageId);
  }

  private async consumeInput(tenant: AgentConfig, state: ConversationState, definition: WorkflowDefinition, step: WorkflowStep, input: string, externalMessageId: string): Promise<WorkflowTurnResult | undefined> {
    const workflow = state.workflow!;

    if (step.type === "collect") {
      let value = input;
      if (step.transform === "trim") value = value.trim();
      if (step.transform === "digits") value = value.replace(/\D/g, "");
      const v = step.validation;
      const invalid = (v?.minLength !== undefined && value.length < v.minLength) || (v?.maxLength !== undefined && value.length > v.maxLength) || (v?.regex !== undefined && !new RegExp(v.regex).test(value));
      if (invalid) return this.textResult(step.errorMessage ?? step.prompt);
      setPath(workflow.data, step.field, value); this.next(workflow); return undefined;
    }

    if (step.type === "select") {
      const candidates = this.selectionCandidates(step, workflow.data);
      const selected = this.parseSelection(input, candidates);
      if (!selected) return this.textResult(step.invalidMessage ?? this.selectionPrompt(step, candidates, workflow.data, state));
      setPath(workflow.data, step.field, step.store === "value" ? selected.value : selected.item);
      this.next(workflow); return undefined;
    }

    if (step.type === "confirm") {
      const yes = (step.yesValues ?? ["si", "sí", "yes", "1"]).map(normalizeAnswer);
      const no = (step.noValues ?? ["no", "2"]).map(normalizeAnswer);
      const answer = normalizeAnswer(input);
      if (yes.includes(answer)) { setPath(workflow.data, step.field, true); this.next(workflow); return undefined; }
      if (no.includes(answer)) {
        setPath(workflow.data, step.field, false);
        if ((step.onReject ?? "cancel") === "cancel") {
          workflow.status = "cancelled"; workflow.awaiting = undefined; this.clearTerminalData(definition, workflow);
          await this.store.audit(tenant.tenantId, "workflow.cancelled", { workflowId: workflow.workflowId, userId: state.userId, reason: "confirmation_rejected", stepId: step.id });
          return this.textResult(step.rejectMessage ?? "Proceso cancelado.");
        }
        this.next(workflow); return undefined;
      }
      return this.textResult(step.invalidMessage ?? step.prompt);
    }

    if (step.type === "consent") {
      const yes = (step.yesValues ?? ["si", "sí", "acepto", "1"]).map(normalizeAnswer);
      const no = (step.noValues ?? ["no", "no acepto", "2"]).map(normalizeAnswer);
      const answer = normalizeAnswer(input);
      if (yes.includes(answer)) {
        const subjectId = this.consentSubject(step.subjectFrom, workflow.data, state.userId);
        const record: ConsentRecord = {
          tenantId: tenant.tenantId, subjectId, policyId: step.policyId, version: step.version ?? "1",
          acceptedAt: new Date().toISOString(), channel: state.channel, conversationId: state.conversationId,
        };
        await this.store.recordConsent(record);
        await this.store.audit(tenant.tenantId, "consent.accepted", { subjectId, policyId: step.policyId, version: step.version ?? "1", conversationId: state.conversationId });
        this.next(workflow); return undefined;
      }
      if (no.includes(answer)) {
        workflow.status = "cancelled"; workflow.awaiting = undefined; this.clearTerminalData(definition, workflow);
        await this.store.audit(tenant.tenantId, "consent.rejected", { policyId: step.policyId, userId: state.userId });
        return this.textResult(step.rejectMessage ?? "No es posible continuar sin la aceptación requerida.");
      }
      return this.textResult(step.invalidMessage ?? this.consentPrompt(step.prompt, step.documentUrl));
    }

    if (step.type === "verification") {
      const ctx = this.context(workflow.data, state, input);
      const verifyInput = (renderValue(step.verifyInput ?? { code: "{{input}}" }, ctx) ?? {}) as Record<string, unknown>;
      const toolContext: ToolContext = { tenant, state, externalMessageId };
      const result = await this.tools.executeByName(tenant, step.verifyTool, toolContext, verifyInput, "workflow");
      if (!result.ok) {
        if (result.error && (step.terminalErrorCodes ?? ["OTP_EXPIRED", "OTP_LOCKED", "OTP_ALREADY_USED"]).includes(result.error.code)) {
          workflow.status = "cancelled"; workflow.awaiting = undefined; this.clearTerminalData(definition, workflow);
          return this.textResult(step.terminalMessage ?? result.error.message);
        }
        return this.textResult(step.invalidMessage ?? result.error?.message ?? "No se pudo validar el código.");
      }
      const verified = step.successPath ? Boolean(getPath(result.data, step.successPath)) : true;
      if (!verified) return this.textResult(step.invalidMessage ?? "El código ingresado no es válido.");
      const now = Math.floor(Date.now() / 1000);
      const rawSubject = step.subjectFrom ? getPath(workflow.data, step.subjectFrom) : state.userId;
      if (rawSubject === undefined || rawSubject === null || String(rawSubject).trim() === "") {
        workflow.status = "cancelled"; workflow.awaiting = undefined; this.clearTerminalData(definition, workflow);
        if (!definition.retainDataOnCompletion) workflow.data = {};
        return this.textResult(step.terminalMessage ?? "No se pudo vincular la verificación a una identidad.");
      }
      state.verification = {
        level: "otp",
        verifiedAt: new Date().toISOString(),
        expiresAt: now + (step.sessionTtlSeconds ?? tenant.otp?.sessionTtlSeconds ?? 900),
        subjectId: String(rawSubject),
      };
      this.next(workflow);
      await this.store.audit(tenant.tenantId, "workflow.verification_succeeded", { workflowId: workflow.workflowId, stepId: step.id, userId: state.userId });
      return undefined;
    }

    throw new Error(`Step ${step.id} cannot consume user input.`);
  }

  private async advance(tenant: AgentConfig, state: ConversationState, definition: WorkflowDefinition, externalMessageId: string): Promise<WorkflowTurnResult> {
    const workflow = state.workflow!;
    const outbound: OutboundMessage[] = [];
    const toolCalls: string[] = [];

    for (let guard = 0; guard < 50; guard += 1) {
      workflow.updatedAt = new Date().toISOString();
      const step = definition.steps[workflow.stepIndex];

      if (!step) {
        workflow.status = "completed"; workflow.awaiting = undefined; this.clearTerminalData(definition, workflow);
        await this.store.audit(tenant.tenantId, "workflow.completed", { workflowId: workflow.workflowId, userId: state.userId });
        return this.result(outbound, toolCalls);
      }

      if (step.type === "collect") {
        workflow.awaiting = { stepId: step.id, kind: "collect" };
        outbound.push({ kind: "text", text: renderTemplate(step.prompt, this.context(workflow.data, state)) });
        return this.result(outbound, toolCalls);
      }

      if (step.type === "select") {
        const candidates = this.selectionCandidates(step, workflow.data);
        if (candidates.length === 0) {
          workflow.status = "cancelled"; workflow.awaiting = undefined; this.clearTerminalData(definition, workflow);
          outbound.push({ kind: "text", text: step.emptyMessage ?? "No existen opciones disponibles para continuar." });
          return this.result(outbound, toolCalls);
        }
        if (candidates.length === 1 && step.autoSelectSingle) {
          const selected = candidates[0]!;
          setPath(workflow.data, step.field, step.store === "value" ? selected.value : selected.item);
          this.next(workflow); continue;
        }
        workflow.awaiting = { stepId: step.id, kind: "select" };
        outbound.push({ kind: "text", text: this.selectionPrompt(step, candidates, workflow.data, state) });
        return this.result(outbound, toolCalls);
      }

      if (step.type === "confirm") {
        workflow.awaiting = { stepId: step.id, kind: "confirm" };
        outbound.push({ kind: "text", text: renderTemplate(step.prompt, this.context(workflow.data, state)) });
        return this.result(outbound, toolCalls);
      }

      if (step.type === "consent") {
        const subjectId = this.consentSubject(step.subjectFrom, workflow.data, state.userId);
        const accepted = await this.store.hasConsent(tenant.tenantId, subjectId, step.policyId, step.version ?? "1");
        if (accepted) { this.next(workflow); continue; }
        workflow.awaiting = { stepId: step.id, kind: "consent" };
        outbound.push({ kind: "text", text: this.consentPrompt(renderTemplate(step.prompt, this.context(workflow.data, state)), step.documentUrl) });
        return this.result(outbound, toolCalls);
      }

      if (step.type === "verification") {
        const now = Math.floor(Date.now() / 1000);
        if (step.skipIfVerified !== false && state.verification.level === "otp" && (state.verification.expiresAt ?? 0) > now) { this.next(workflow); continue; }
        const toolContext: ToolContext = { tenant, state, externalMessageId };
        const startInput = (renderValue(step.startInput ?? {}, this.context(workflow.data, state)) ?? {}) as Record<string, unknown>;
        const result = await this.tools.executeByName(tenant, step.startTool, toolContext, startInput, "workflow");
        toolCalls.push(step.startTool);
        if (!result.ok) {
          workflow.status = "cancelled"; workflow.awaiting = undefined; this.clearTerminalData(definition, workflow);
          outbound.push({ kind: "text", text: step.terminalMessage ?? result.error?.message ?? "No se pudo iniciar la verificación." });
          return this.result(outbound, toolCalls);
        }
        setPath(workflow.data, `_verification.${step.id}`, result.data ?? {});
        workflow.awaiting = { stepId: step.id, kind: "verification" };
        outbound.push({ kind: "text", text: renderTemplate(step.prompt, this.context(workflow.data, state)) });
        return this.result(outbound, toolCalls);
      }

      if (step.type === "tool") {
        const toolContext: ToolContext = { tenant, state, externalMessageId };
        const input = (renderValue(step.input ?? {}, this.context(workflow.data, state)) ?? {}) as Record<string, unknown>;
        const result = await this.tools.executeByName(tenant, step.tool, toolContext, input, "workflow");
        toolCalls.push(step.tool);
        if (!result.ok) {
          workflow.status = "cancelled"; workflow.awaiting = undefined; this.clearTerminalData(definition, workflow);
          outbound.push({ kind: "text", text: step.onErrorMessage ?? result.error?.message ?? `No se pudo ejecutar ${step.tool}.` });
          await this.store.audit(tenant.tenantId, "workflow.tool_failed", { workflowId: workflow.workflowId, stepId: step.id, tool: step.tool, code: result.error?.code });
          return this.result(outbound, toolCalls);
        }
        if (step.saveAs) setPath(workflow.data, step.saveAs, result.data);
        this.next(workflow); continue;
      }

      if (step.type === "branch") {
        const value = getPath(workflow.data, step.path);
        const target = step.cases[String(value)] ?? step.default;
        if (!target) throw new Error(`Branch ${step.id} has no target for value ${String(value)}.`);
        workflow.stepIndex = this.stepIndex(definition, target); workflow.awaiting = undefined; continue;
      }

      if (step.type === "render") {
        outbound.push({ kind: "text", text: renderTemplate(step.template, this.context(workflow.data, state)) });
        this.next(workflow); continue;
      }

      if (step.type === "render_list") {
        const source = getPath(workflow.data, step.source);
        if (!Array.isArray(source) || source.length === 0) {
          outbound.push({ kind: "text", text: step.emptyMessage ?? "No existen elementos para mostrar." });
          this.next(workflow); continue;
        }
        const items = source.slice(0, step.maxItems ?? source.length).map((item, index) =>
          renderTemplate(step.itemTemplate, { ...this.context(workflow.data, state), item, index: index + 1 })
        );
        const header = step.header ? renderTemplate(step.header, this.context(workflow.data, state)) + "\n" : "";
        outbound.push({ kind: "text", text: header + items.join("\n") });
        this.next(workflow); continue;
      }

      if (step.type === "deliver") {
        const url = getPath(workflow.data, step.urlFrom);
        if (typeof url !== "string" || !url) throw new Error(`Delivery step ${step.id} could not resolve document URL.`);
        const filenameValue = step.filenameFrom ? getPath(workflow.data, step.filenameFrom) : undefined;
        outbound.push({ kind: "document", url, filename: filenameValue === undefined ? undefined : String(filenameValue), caption: step.caption ? renderTemplate(step.caption, this.context(workflow.data, state)) : undefined });
        this.next(workflow); continue;
      }

      if (step.type === "end") {
        if (step.message) outbound.push({ kind: "text", text: renderTemplate(step.message, this.context(workflow.data, state)) });
        workflow.status = "completed"; workflow.awaiting = undefined; this.clearTerminalData(definition, workflow);
        await this.store.audit(tenant.tenantId, "workflow.completed", { workflowId: workflow.workflowId, userId: state.userId });
        return this.result(outbound, toolCalls);
      }
    }
    throw new Error(`Workflow ${definition.id} exceeded the internal step guard.`);
  }

  private getDefinition(tenant: AgentConfig, workflowId: string): WorkflowDefinition {
    const definition = (tenant.workflows ?? []).find((workflow) => workflow.id === workflowId);
    if (!definition) throw new Error(`Workflow ${workflowId} is not configured for tenant ${tenant.tenantId}.`);
    return definition;
  }

  private context(data: Record<string, unknown>, state: ConversationState, input?: string): Record<string, unknown> {
    return { ...data, input, state: { userId: state.userId, channel: state.channel, conversationId: state.conversationId } };
  }

  private selectionCandidates(step: WorkflowSelectStep, data: Record<string, unknown>): SelectionCandidate[] {
    if (step.options) return step.options.map((option: WorkflowSelectOption) => ({ value: option.value, label: option.label, item: option.value }));
    const source = step.source ? getPath(data, step.source) : undefined;
    if (!Array.isArray(source)) return [];
    const filtered = step.filter
      ? source.filter((item) => getPath(item, step.filter!.path) === renderValue(step.filter!.equals, data))
      : source;
    return filtered.map((item, index) => {
      const value = step.valuePath ? getPath(item, step.valuePath) : index + 1;
      const label = step.labelPath ? getPath(item, step.labelPath) : value;
      return { value: value ?? index + 1, label: String(label ?? value ?? index + 1), item };
    });
  }

  private parseSelection(input: string, candidates: SelectionCandidate[]): SelectionCandidate | undefined {
    const trimmed = input.trim();
    const numeric = Number(trimmed);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= candidates.length) return candidates[numeric - 1];
    const normalized = normalizeAnswer(trimmed);
    return candidates.find((candidate) => normalizeAnswer(String(candidate.value)) === normalized || normalizeAnswer(candidate.label) === normalized);
  }

  private selectionPrompt(step: WorkflowSelectStep, candidates: SelectionCandidate[], data: Record<string, unknown>, state: ConversationState): string {
    const header = renderTemplate(step.prompt, this.context(data, state));
    return `${header}\n${candidates.map((candidate, index) => `${index + 1}. ${candidate.label}`).join("\n")}`;
  }

  private consentPrompt(prompt: string, documentUrl?: string): string { return documentUrl ? `${prompt}\n${documentUrl}` : prompt; }
  private consentSubject(path: string | undefined, data: Record<string, unknown>, fallback: string): string {
    if (!path) return fallback;
    const resolved = getPath(data, path);
    return resolved === undefined || resolved === null || resolved === "" ? fallback : String(resolved);
  }
  private next(workflow: WorkflowState): void { workflow.stepIndex += 1; workflow.awaiting = undefined; }
  private clearTerminalData(definition: WorkflowDefinition, workflow: WorkflowState): void {
    if (!definition.retainDataOnCompletion) workflow.data = {};
  }
  private stepIndex(definition: WorkflowDefinition, stepId: string): number {
    const index = definition.steps.findIndex((step) => step.id === stepId);
    if (index < 0) throw new Error(`Unknown workflow step ${stepId}.`);
    return index;
  }
  private textResult(text: string): WorkflowTurnResult { return { text, outbound: text ? [{ kind: "text", text }] : [], toolCalls: [] }; }
  private result(outbound: OutboundMessage[], toolCalls: string[]): WorkflowTurnResult {
    const text = outbound.filter((message): message is Extract<OutboundMessage, { kind: "text" }> => message.kind === "text").map((message) => message.text).join("\n\n");
    return { text, outbound, toolCalls };
  }
}

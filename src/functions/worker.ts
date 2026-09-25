import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { AgentRuntime } from "../core/agent-runtime.js";
import type { AgentRunResult, InboundEnvelope, ModelConfig } from "../core/types.js";
import { sha256, safeEqualHex } from "../core/security.js";
import { PlatformStore } from "../storage/dynamo.js";
import { MetaWhatsAppChannel } from "../channels/whatsapp.js";
import { log } from "../core/logger.js";
import { ToolRegistry } from "../core/tool-registry.js";
import { WorkflowRuntime } from "../workflows/runtime.js";
import { ModelProviderRegistry } from "../ports/model.js";
import { ConversationBusyError, ConversationConflictError } from "../ports/store.js";
import { AwsSecretsManagerProvider } from "../adapters/aws/secrets-manager.js";
import { AwsOtpDeliveryProvider } from "../adapters/aws/otp-delivery.js";
import { BedrockModelProvider } from "../adapters/aws/bedrock-model.js";

const store = new PlatformStore();
const secrets = new AwsSecretsManagerProvider();
const whatsapp = new MetaWhatsAppChannel(secrets);
const otpDelivery = new AwsOtpDeliveryProvider();
const otpHmacSecret = process.env.OTP_HMAC_SECRET_REF ?? process.env.OTP_HMAC_SECRET_ARN ?? "";
const tools = new ToolRegistry(store, secrets, otpDelivery, otpHmacSecret);
const workflows = new WorkflowRuntime(store, tools);
const models = new ModelProviderRegistry([new BedrockModelProvider()]);
const defaultModel: ModelConfig | undefined = process.env.DEFAULT_MODEL_ID
  ? { provider: process.env.DEFAULT_MODEL_PROVIDER ?? "bedrock", model: process.env.DEFAULT_MODEL_ID }
  : undefined;
const runtime = new AgentRuntime(store, models, tools, workflows, { defaultModel });

const MAX_WEB_MESSAGE_CHARS = 8000;
const MAX_WEB_ID_CHARS = 256;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

function apiBody(event: APIGatewayProxyEventV2): string {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

function isSqsEvent(event: SQSEvent | APIGatewayProxyEventV2): event is SQSEvent {
  return "Records" in event && Array.isArray(event.Records);
}

async function authenticateApi(event: APIGatewayProxyEventV2) {
  const tenantId = event.headers["x-tenant-id"];
  const apiKey = event.headers["x-api-key"];
  if (!tenantId || !apiKey) return undefined;
  const tenant = await store.getTenant(tenantId);
  if (!tenant?.enabled || !tenant.apiKeyHash) return undefined;
  return safeEqualHex(sha256(apiKey), tenant.apiKeyHash) ? tenant : undefined;
}

async function processInbound(inbound: InboundEnvelope, sendReply: boolean): Promise<AgentRunResult | undefined> {
  const replyTarget = inbound.replyTarget ?? (inbound.replyTo ? {
    value: inbound.replyTo,
    kind: inbound.replyToType ?? "phone",
  } : undefined);

  const processed = await store.getProcessedEvent(inbound.externalMessageId);
  if (processed) {
    if (sendReply && replyTarget && !processed.deliveredAt && processed.outbound.length > 0) {
      const replayTenant = processed.configVersion
        ? await store.getTenantVersion(inbound.tenantId, processed.configVersion)
        : await store.getTenant(inbound.tenantId);
      if (!replayTenant?.enabled) throw new Error(`Tenant ${inbound.tenantId} is missing or disabled during outbound replay.`);
      for (const message of processed.outbound) await whatsapp.send(replayTenant, replyTarget, message);
      await store.markEventDelivered(inbound.externalMessageId);
    }
    return undefined;
  }

  const tenant = await store.getTenant(inbound.tenantId);
  if (!tenant?.enabled) throw new Error(`Tenant ${inbound.tenantId} is missing or disabled.`);

  const leaseOwner = inbound.channel === "web" ? randomUUID() : undefined;
  if (leaseOwner) {
    const acquired = await store.acquireConversationLease(tenant.tenantId, inbound.channel, inbound.conversationId, leaseOwner);
    if (!acquired) throw new ConversationBusyError();
  }

  try {
    const result = await runtime.execute(tenant, inbound);

    if (sendReply && replyTarget) {
      const sendTenant = result.state.configVersion && result.state.configVersion !== tenant.configVersion
        ? (await store.getTenantVersion(tenant.tenantId, result.state.configVersion) ?? tenant)
        : tenant;
      for (const message of result.outbound) await whatsapp.send(sendTenant, replyTarget, message);
    }
    await store.markEventDelivered(inbound.externalMessageId);
    return result;
  } finally {
    if (leaseOwner) await store.releaseConversationLease(tenant.tenantId, inbound.channel, inbound.conversationId, leaseOwner);
  }
}

async function handleSqs(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    try {
      const inbound = JSON.parse(record.body) as InboundEnvelope;
      await processInbound(inbound, inbound.channel === "whatsapp");
    } catch (error) {
      log("error", "Worker failed to process message", {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      failures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures: failures };
}

async function handleApi(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const tenant = await authenticateApi(event);
  if (!tenant) return json(401, { error: "unauthorized" });

  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (method === "POST" && path === "/v1/chat") {
    let body: Record<string, unknown>;
    try { body = JSON.parse(apiBody(event) || "{}") as Record<string, unknown>; } catch { return json(400, { error: "invalid_json" }); }

    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const message = typeof body.message === "string" ? body.message : "";
    const requestedConversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : undefined;

    if (!userId || !message.trim()) return json(400, { error: "userId_and_message_required" });
    if (userId.length > MAX_WEB_ID_CHARS || (requestedConversationId?.length ?? 0) > MAX_WEB_ID_CHARS) {
      return json(400, { error: "identifier_too_long", maxChars: MAX_WEB_ID_CHARS });
    }
    if (message.length > MAX_WEB_MESSAGE_CHARS) return json(413, { error: "message_too_large", maxChars: MAX_WEB_MESSAGE_CHARS });

    const conversationId = requestedConversationId || userId;
    const inbound: InboundEnvelope = {
      tenantId: tenant.tenantId,
      channel: "web",
      conversationId,
      userId,
      text: message,
      externalMessageId: `web:${randomUUID()}`,
      receivedAt: new Date().toISOString(),
    };

    try {
      const result = await processInbound(inbound, false);
      return json(200, {
        reply: result?.text ?? "",
        messages: result?.outbound ?? [],
        conversationId,
        revision: result?.state.revision,
        workflow: result?.state.workflow ? {
          id: result.state.workflow.workflowId,
          status: result.state.workflow.status,
        } : undefined,
      });
    } catch (error) {
      if (error instanceof ConversationBusyError || error instanceof ConversationConflictError) {
        return json(409, { error: "conversation_busy", retryable: true });
      }
      throw error;
    }
  }

  const modeMatch = path.match(/^\/v1\/conversations\/(whatsapp|web)\/([^/]+)\/mode$/);
  if (method === "POST" && modeMatch) {
    let body: { mode?: "ai" | "human" };
    try { body = JSON.parse(apiBody(event) || "{}") as { mode?: "ai" | "human" }; } catch { return json(400, { error: "invalid_json" }); }
    if (body.mode !== "ai" && body.mode !== "human") return json(400, { error: "mode_must_be_ai_or_human" });

    const channel = modeMatch[1]!;
    const conversationId = decodeURIComponent(modeMatch[2]!);
    await store.setConversationMode(tenant.tenantId, channel, conversationId, body.mode);
    await store.audit(tenant.tenantId, "conversation.mode_changed", { channel, conversationId, mode: body.mode });
    return json(200, { ok: true, channel, conversationId, mode: body.mode });
  }

  return json(404, { error: "not_found" });
}

export async function handler(event: SQSEvent | APIGatewayProxyEventV2): Promise<SQSBatchResponse | APIGatewayProxyResultV2> {
  return isSqsEvent(event) ? handleSqs(event) : handleApi(event);
}

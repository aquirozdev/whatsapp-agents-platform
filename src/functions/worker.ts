import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, SQSBatchResponse, SQSEvent } from "aws-lambda";
import type { AgentRunResult, InboundEnvelope } from "../core/types.js";
import { sha256, safeEqualHex } from "../core/security.js";
import { ConversationConflictError } from "../storage/dynamo.js";
import { composeAwsRuntime } from "../composition/aws.js";
import { log } from "../core/logger.js";

const { store, runtime, whatsapp } = composeAwsRuntime();

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
  const activeTenant = await store.getTenant(inbound.tenantId);
  if (!activeTenant?.enabled) throw new Error(`Tenant ${inbound.tenantId} is missing or disabled.`);

  const existing = await store.getEvent(inbound.externalMessageId);
  if (existing?.status === "completed") return undefined;

  if (existing?.status === "prepared") {
    const deliveryTenant = existing.configVersion
      ? (await store.getTenantVersion(inbound.tenantId, existing.configVersion)) ?? activeTenant
      : activeTenant;
    if (sendReply) await whatsapp.send(deliveryTenant, inbound, existing.outbound);
    await store.completeEvent(inbound.externalMessageId);
    return undefined;
  }

  const result = await runtime.execute(activeTenant, inbound);
  if (sendReply) await whatsapp.send(activeTenant, inbound, result.outbound);
  await store.completeEvent(inbound.externalMessageId);
  return result;
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
    try {
      body = JSON.parse(apiBody(event) || "{}") as Record<string, unknown>;
    } catch {
      return json(400, { error: "invalid_json" });
    }

    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const message = typeof body.message === "string" ? body.message : "";
    const requestedConversationId = typeof body.conversationId === "string" ? body.conversationId.trim() : undefined;

    if (!userId || !message.trim()) return json(400, { error: "userId_and_message_required" });
    if (userId.length > MAX_WEB_ID_CHARS || (requestedConversationId?.length ?? 0) > MAX_WEB_ID_CHARS) {
      return json(400, { error: "identifier_too_long", maxChars: MAX_WEB_ID_CHARS });
    }
    if (message.length > MAX_WEB_MESSAGE_CHARS) {
      return json(413, { error: "message_too_large", maxChars: MAX_WEB_MESSAGE_CHARS });
    }

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
        workflow: result?.state.workflow ? {
          id: result.state.workflow.workflowId,
          status: result.state.workflow.status,
          configVersion: result.state.workflow.configVersion,
        } : undefined,
      });
    } catch (error) {
      if (error instanceof ConversationConflictError) {
        return json(409, { error: "conversation_conflict", retryable: true });
      }
      throw error;
    }
  }

  const modeMatch = path.match(/^\/v1\/conversations\/([^/]+)\/([^/]+)\/mode$/);
  if (method === "POST" && modeMatch) {
    let body: { mode?: "ai" | "human" };
    try {
      body = JSON.parse(apiBody(event) || "{}") as { mode?: "ai" | "human" };
    } catch {
      return json(400, { error: "invalid_json" });
    }
    if (body.mode !== "ai" && body.mode !== "human") return json(400, { error: "mode_must_be_ai_or_human" });

    const channel = decodeURIComponent(modeMatch[1]!);
    const conversationId = decodeURIComponent(modeMatch[2]!);
    await store.setConversationMode(tenant.tenantId, channel, conversationId, body.mode);
    await store.audit(tenant.tenantId, "conversation.mode_changed", { channel, conversationId, mode: body.mode });
    return json(200, { ok: true, channel, conversationId, mode: body.mode });
  }

  return json(404, { error: "not_found" });
}

export async function handler(
  event: SQSEvent | APIGatewayProxyEventV2,
): Promise<SQSBatchResponse | APIGatewayProxyResultV2> {
  return isSqsEvent(event) ? handleSqs(event) : handleApi(event);
}

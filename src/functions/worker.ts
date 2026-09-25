import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { AgentRuntime } from "../core/agent-runtime.js";
import type { AgentRunResult, InboundEnvelope } from "../core/types.js";
import { sha256, safeEqualHex } from "../core/security.js";
import { PlatformStore } from "../storage/dynamo.js";
import { sendWhatsAppOutbound } from "../channels/whatsapp.js";
import { log } from "../core/logger.js";

const store = new PlatformStore();
const runtime = new AgentRuntime(store);

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
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
  if (await store.isEventProcessed(inbound.externalMessageId)) return undefined;

  const tenant = await store.getTenant(inbound.tenantId);
  if (!tenant?.enabled) throw new Error(`Tenant ${inbound.tenantId} is missing or disabled.`);

  const result = await runtime.execute(tenant, inbound);

  if (sendReply && inbound.replyTo) {
    for (const message of result.outbound) await sendWhatsAppOutbound(tenant, inbound.replyTo, message);
  }

  await store.markEventProcessed(inbound.externalMessageId);
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
    let body: { userId?: string; message?: string; conversationId?: string };
    try { body = JSON.parse(event.body ?? "{}"); } catch { return json(400, { error: "invalid_json" }); }
    if (!body.userId || !body.message) return json(400, { error: "userId_and_message_required" });

    const conversationId = body.conversationId ?? body.userId;
    const inbound: InboundEnvelope = {
      tenantId: tenant.tenantId,
      channel: "web",
      conversationId,
      userId: body.userId,
      text: body.message,
      externalMessageId: `web:${randomUUID()}`,
      receivedAt: new Date().toISOString(),
    };

    const result = await processInbound(inbound, false);
    return json(200, {
      reply: result?.text ?? "",
      messages: result?.outbound ?? [],
      conversationId,
      workflow: result?.state.workflow ? {
        id: result.state.workflow.workflowId,
        status: result.state.workflow.status,
      } : undefined,
    });
  }

  const modeMatch = path.match(/^\/v1\/conversations\/(whatsapp|web)\/([^/]+)\/mode$/);
  if (method === "POST" && modeMatch) {
    let body: { mode?: "ai" | "human" };
    try { body = JSON.parse(event.body ?? "{}"); } catch { return json(400, { error: "invalid_json" }); }
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

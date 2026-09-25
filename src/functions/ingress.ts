import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { parseWhatsAppMessages, toInboundEnvelope } from "../channels/whatsapp.js";
import { PlatformStore } from "../storage/dynamo.js";
import { getSecret } from "../providers/secrets.js";
import { verifyMetaSignature } from "../core/security.js";
import { log } from "../core/logger.js";

const store = new PlatformStore();
const sqs = new SQSClient({});

function response(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) };
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath;
  if (event.requestContext.http.method === "GET" && path === "/health") return response(200, { ok: true, service: "ingress" });
  if (path !== "/webhooks/whatsapp") return response(404, { error: "not_found" });

  if (event.requestContext.http.method === "GET") {
    const arn = process.env.WHATSAPP_VERIFY_TOKEN_SECRET_ARN;
    if (!arn) return response(500, { error: "verify_token_not_configured" });
    const expected = await getSecret(arn);
    const mode = event.queryStringParameters?.["hub.mode"];
    const token = event.queryStringParameters?.["hub.verify_token"];
    const challenge = event.queryStringParameters?.["hub.challenge"];
    if (mode === "subscribe" && token === expected && challenge) {
      return { statusCode: 200, headers: { "content-type": "text/plain" }, body: challenge };
    }
    return response(403, { error: "verification_failed" });
  }

  if (event.requestContext.http.method !== "POST") return response(405, { error: "method_not_allowed" });
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
  const appSecretArn = process.env.META_APP_SECRET_ARN;
  if (!appSecretArn) return response(500, { error: "meta_app_secret_not_configured" });
  const appSecret = await getSecret(appSecretArn);
  const signature = event.headers["x-hub-signature-256"];
  if (!verifyMetaSignature(rawBody, signature, appSecret)) return response(401, { error: "invalid_signature" });

  const queueUrl = process.env.QUEUE_URL;
  if (!queueUrl) return response(500, { error: "queue_not_configured" });
  const parsedMessages = parseWhatsAppMessages(rawBody);
  for (const message of parsedMessages) {
    const tenant = await store.getTenantByWhatsAppPhoneNumberId(message.phoneNumberId);
    if (!tenant?.enabled) {
      log("warn", "Ignoring message for unknown or disabled WhatsApp phone number", { phoneNumberId: message.phoneNumberId });
      continue;
    }
    const envelope = toInboundEnvelope(tenant, message);
    await sqs.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: `${tenant.tenantId}:${message.userId}`,
      MessageDeduplicationId: message.externalMessageId,
    }));
  }
  return response(200, { accepted: parsedMessages.length });
}

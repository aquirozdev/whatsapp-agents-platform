import type { AgentConfig, InboundEnvelope, OutboundMessage } from "../core/types.js";
import type { SecretProvider } from "../ports/secrets.js";

interface MetaWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: Array<{
          id?: string;
          from?: string;
          from_user_id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          button?: { text?: string };
          interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
        }>;
      };
    }>;
  }>;
}

export interface ParsedWhatsAppMessage {
  phoneNumberId: string;
  userId: string;
  replyTo: string;
  replyToType: "phone" | "whatsapp_user_id";
  externalMessageId: string;
  text: string;
  receivedAt: string;
}

export function parseWhatsAppMessages(rawBody: string): ParsedWhatsAppMessage[] {
  const payload = JSON.parse(rawBody) as MetaWebhookPayload;
  const parsed: ParsedWhatsAppMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const phoneNumberId = change.value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      for (const message of change.value?.messages ?? []) {
        const text = message.text?.body ?? message.button?.text ?? message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title;
        const stableUserId = message.from_user_id ?? message.from;
        const replyTo = message.from ?? message.from_user_id;
        if (!text || !message.id || !stableUserId || !replyTo) continue;
        parsed.push({
          phoneNumberId,
          userId: stableUserId,
          replyTo,
          replyToType: message.from ? "phone" : "whatsapp_user_id",
          externalMessageId: message.id,
          text,
          receivedAt: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString(),
        });
      }
    }
  }
  return parsed;
}

export function toInboundEnvelope(tenant: AgentConfig, parsed: ParsedWhatsAppMessage): InboundEnvelope {
  return {
    tenantId: tenant.tenantId,
    channel: "whatsapp",
    conversationId: parsed.userId,
    userId: parsed.userId,
    text: parsed.text,
    externalMessageId: parsed.externalMessageId,
    receivedAt: parsed.receivedAt,
    replyTarget: { value: parsed.replyTo, kind: parsed.replyToType },
    replyTo: parsed.replyTo,
    replyToType: parsed.replyToType,
  };
}

export async function sendWhatsAppOutbound(
  tenant: AgentConfig,
  recipient: { value: string; type: "phone" | "whatsapp_user_id" },
  message: OutboundMessage,
  secrets: SecretProvider,
): Promise<void> {
  if (!tenant.whatsapp) throw new Error(`Tenant ${tenant.tenantId} has no WhatsApp configuration.`);
  const secretRef = tenant.whatsapp.accessTokenSecret ?? tenant.whatsapp.accessTokenSecretArn;
  if (!secretRef) throw new Error(`Tenant ${tenant.tenantId} has no WhatsApp access-token secret.`);
  const token = await secrets.get(secretRef);
  const endpoint = `https://graph.facebook.com/${tenant.whatsapp.graphApiVersion}/${tenant.whatsapp.phoneNumberId}/messages`;

  const body = message.kind === "text"
    ? {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...(recipient.type === "phone" ? { to: recipient.value } : { recipient: recipient.value }),
        type: "text",
        text: { body: message.text },
      }
    : {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...(recipient.type === "phone" ? { to: recipient.value } : { recipient: recipient.value }),
        type: "document",
        document: {
          link: message.url,
          ...(message.filename ? { filename: message.filename } : {}),
          ...(message.caption ? { caption: message.caption } : {}),
        },
      };

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(tenant.whatsapp.sendTimeoutMs ?? 10000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown";
    throw new Error(`WhatsApp send failed before receiving a response (${reason}).`);
  }

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`WhatsApp send failed (${response.status}): ${responseBody.slice(0, 1000)}`);
  }
}

import type { AgentConfig, InboundEnvelope, OutboundMessage } from "../core/types.js";
import { getSecret } from "../providers/secrets.js";

interface MetaWebhookPayload {
  entry?: Array<{
    changes?: Array<{
      value?: {
        metadata?: { phone_number_id?: string };
        messages?: Array<{
          id?: string;
          from?: string;
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
        if (!text || !message.id || !message.from) continue;
        parsed.push({
          phoneNumberId,
          userId: message.from,
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
    replyTo: parsed.userId,
  };
}

export async function sendWhatsAppOutbound(tenant: AgentConfig, to: string, message: OutboundMessage): Promise<void> {
  if (!tenant.whatsapp) throw new Error(`Tenant ${tenant.tenantId} has no WhatsApp configuration.`);
  const token = await getSecret(tenant.whatsapp.accessTokenSecretArn);
  const endpoint = `https://graph.facebook.com/${tenant.whatsapp.graphApiVersion}/${tenant.whatsapp.phoneNumberId}/messages`;

  const body = message.kind === "text"
    ? {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: message.text },
      }
    : {
        messaging_product: "whatsapp",
        to,
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

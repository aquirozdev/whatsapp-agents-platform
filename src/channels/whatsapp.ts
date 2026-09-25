import type {
  AgentConfig,
  ChannelDeliveryReceipt,
  ChannelDeliveryStatus,
  InboundContent,
  InboundEnvelope,
  OutboundMessage,
} from "../core/types.js";
import type { SecretProvider } from "../ports/secrets.js";
import type { ChannelAdapter, ChannelInboundMessage } from "../ports/channel.js";

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
          image?: { id?: string; mime_type?: string; caption?: string };
          audio?: { id?: string; mime_type?: string };
          document?: { id?: string; mime_type?: string; filename?: string; caption?: string };
          location?: { latitude?: number; longitude?: number; name?: string; address?: string };
          interactive?: {
            button_reply?: { id?: string; title?: string };
            list_reply?: { id?: string; title?: string };
          };
        }>;
        statuses?: Array<{
          id?: string;
          status?: string;
          timestamp?: string;
          errors?: Array<{ code?: number; title?: string; message?: string }>;
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
  content: InboundContent[];
  receivedAt: string;
}

type MetaMessage = NonNullable<
  NonNullable<
    NonNullable<MetaWebhookPayload["entry"]>[number]["changes"]
  >[number]["value"]
> extends { messages?: Array<infer M> } ? M : never;

function contentFromMessage(message: MetaMessage): InboundContent[] {
  if (message.text?.body) return [{ kind: "text", text: message.text.body }];
  if (message.button?.text) return [{ kind: "interactive_reply", title: message.button.text, replyType: "button" }];
  if (message.interactive?.button_reply?.title) return [{
    kind: "interactive_reply",
    id: message.interactive.button_reply.id,
    title: message.interactive.button_reply.title,
    replyType: "button",
  }];
  if (message.interactive?.list_reply?.title) return [{
    kind: "interactive_reply",
    id: message.interactive.list_reply.id,
    title: message.interactive.list_reply.title,
    replyType: "list",
  }];
  if (message.image?.id) return [{ kind: "image", mediaId: message.image.id, caption: message.image.caption, mimeType: message.image.mime_type }];
  if (message.audio?.id) return [{ kind: "audio", mediaId: message.audio.id, mimeType: message.audio.mime_type }];
  if (message.document?.id) return [{
    kind: "document",
    mediaId: message.document.id,
    filename: message.document.filename,
    caption: message.document.caption,
    mimeType: message.document.mime_type,
  }];
  if (message.location?.latitude !== undefined && message.location.longitude !== undefined) return [{
    kind: "location",
    latitude: message.location.latitude,
    longitude: message.location.longitude,
    name: message.location.name,
    address: message.location.address,
  }];
  return [];
}

function textProjection(content: InboundContent[]): string {
  const first = content[0];
  if (!first) return "";
  if (first.kind === "text") return first.text;
  if (first.kind === "interactive_reply") return first.title;
  if (first.kind === "image") return first.caption ?? "[image]";
  if (first.kind === "document") return first.caption ?? first.filename ?? "[document]";
  if (first.kind === "audio") return "[audio]";
  if (first.kind === "location") return first.name ?? first.address ?? `${first.latitude},${first.longitude}`;
  return "";
}

export function parseWhatsAppMessages(rawBody: string): ParsedWhatsAppMessage[] {
  const payload = JSON.parse(rawBody) as MetaWebhookPayload;
  const parsed: ParsedWhatsAppMessage[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const phoneNumberId = change.value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      for (const message of change.value?.messages ?? []) {
        const content = contentFromMessage(message);
        const stableUserId = message.from_user_id ?? message.from;
        const replyTo = message.from ?? message.from_user_id;
        if (!message.id || !stableUserId || !replyTo || content.length === 0) continue;
        parsed.push({
          phoneNumberId,
          userId: stableUserId,
          replyTo,
          replyToType: message.from ? "phone" : "whatsapp_user_id",
          externalMessageId: message.id,
          text: textProjection(content),
          content,
          receivedAt: message.timestamp ? new Date(Number(message.timestamp) * 1000).toISOString() : new Date().toISOString(),
        });
      }
    }
  }
  return parsed;
}

export function parseWhatsAppDeliveryStatuses(rawBody: string): ChannelDeliveryStatus[] {
  const payload = JSON.parse(rawBody) as MetaWebhookPayload;
  const statuses: ChannelDeliveryStatus[] = [];
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      for (const status of change.value?.statuses ?? []) {
        if (!status.id || !status.status) continue;
        const normalized = ["sent", "delivered", "read", "failed"].includes(status.status)
          ? status.status as ChannelDeliveryStatus["status"]
          : "accepted";
        const error = status.errors?.[0];
        statuses.push({
          providerMessageId: status.id,
          status: normalized,
          occurredAt: status.timestamp ? new Date(Number(status.timestamp) * 1000).toISOString() : new Date().toISOString(),
          errorCode: error?.code === undefined ? undefined : String(error.code),
          errorMessage: error?.message ?? error?.title,
        });
      }
    }
  }
  return statuses;
}

export function toInboundEnvelope(tenant: AgentConfig, parsed: ParsedWhatsAppMessage): InboundEnvelope {
  return {
    tenantId: tenant.tenantId,
    channel: "whatsapp",
    conversationId: parsed.userId,
    userId: parsed.userId,
    text: parsed.text,
    content: parsed.content,
    externalMessageId: parsed.externalMessageId,
    receivedAt: parsed.receivedAt,
    replyTarget: { value: parsed.replyTo, kind: parsed.replyToType },
    replyTo: parsed.replyTo,
    replyToType: parsed.replyToType,
  };
}

function outboundBody(message: OutboundMessage, recipient: { value: string; type: "phone" | "whatsapp_user_id" }): Record<string, unknown> {
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...(recipient.type === "phone" ? { to: recipient.value } : { recipient: recipient.value }),
  };
  if (message.kind === "text") return { ...base, type: "text", text: { body: message.text } };
  if (message.kind === "document") return {
    ...base,
    type: "document",
    document: { link: message.url, ...(message.filename ? { filename: message.filename } : {}), ...(message.caption ? { caption: message.caption } : {}) },
  };
  if (message.kind === "image") return {
    ...base,
    type: "image",
    image: { link: message.url, ...(message.caption ? { caption: message.caption } : {}) },
  };
  if (message.kind === "template") return {
    ...base,
    type: "template",
    template: {
      name: message.name,
      language: { code: message.languageCode },
      ...(message.components ? { components: message.components } : {}),
    },
  };
  if (message.buttons?.length) return {
    ...base,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: message.body },
      action: { buttons: message.buttons.slice(0, 3).map((button) => ({ type: "reply", reply: button })) },
    },
  };
  if (message.list) return {
    ...base,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: message.body },
      action: { button: message.list.buttonText, sections: message.list.sections },
    },
  };
  return { ...base, type: "text", text: { body: message.body } };
}

export async function sendWhatsAppOutbound(
  tenant: AgentConfig,
  recipient: { value: string; type: "phone" | "whatsapp_user_id" },
  message: OutboundMessage,
  secrets: SecretProvider,
): Promise<ChannelDeliveryReceipt> {
  if (!tenant.whatsapp) throw new Error(`Tenant ${tenant.tenantId} has no WhatsApp configuration.`);
  const secretRef = tenant.whatsapp.accessTokenSecret ?? tenant.whatsapp.accessTokenSecretArn;
  if (!secretRef) throw new Error(`Tenant ${tenant.tenantId} has no WhatsApp access-token secret.`);
  const token = await secrets.get(secretRef);
  const endpoint = `https://graph.facebook.com/${tenant.whatsapp.graphApiVersion}/${tenant.whatsapp.phoneNumberId}/messages`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(outboundBody(message, recipient)),
      signal: AbortSignal.timeout(tenant.whatsapp.sendTimeoutMs ?? 10000),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown";
    throw new Error(`WhatsApp send failed before receiving a response (${reason}).`);
  }

  const responseBody = await response.text();
  if (!response.ok) throw new Error(`WhatsApp send failed (${response.status}): ${responseBody.slice(0, 1000)}`);

  let providerMessageId: string | undefined;
  try {
    const payload = JSON.parse(responseBody) as { messages?: Array<{ id?: string }> };
    providerMessageId = payload.messages?.[0]?.id;
  } catch { /* receipt remains provider-id-less */ }

  return { providerMessageId, acceptedAt: new Date().toISOString(), status: "accepted" };
}

export class MetaWhatsAppChannel implements ChannelAdapter {
  readonly id = "whatsapp";
  readonly capabilities = {
    text: true,
    images: true,
    documents: true,
    audio: true,
    templates: true,
    buttons: true,
    lists: true,
  } as const;

  constructor(private readonly secrets: SecretProvider) {}

  parseInbound(rawBody: string): ChannelInboundMessage[] {
    return parseWhatsAppMessages(rawBody).map((message) => ({
      routingKey: message.phoneNumberId,
      userId: message.userId,
      conversationId: message.userId,
      externalMessageId: message.externalMessageId,
      text: message.text,
      content: message.content,
      receivedAt: message.receivedAt,
      replyTarget: { value: message.replyTo, kind: message.replyToType },
      metadata: { phoneNumberId: message.phoneNumberId },
    }));
  }

  parseDeliveryStatuses(rawBody: string): ChannelDeliveryStatus[] {
    return parseWhatsAppDeliveryStatuses(rawBody);
  }

  toEnvelope(tenant: AgentConfig, message: ChannelInboundMessage): InboundEnvelope {
    return {
      tenantId: tenant.tenantId,
      channel: this.id,
      conversationId: message.conversationId,
      userId: message.userId,
      text: message.text,
      content: message.content,
      externalMessageId: message.externalMessageId,
      receivedAt: message.receivedAt,
      replyTarget: message.replyTarget,
      metadata: message.metadata,
    };
  }

  send(tenant: AgentConfig, target: { value: string; kind?: string }, message: OutboundMessage): Promise<ChannelDeliveryReceipt> {
    return sendWhatsAppOutbound(
      tenant,
      { value: target.value, type: target.kind === "whatsapp_user_id" ? "whatsapp_user_id" : "phone" },
      message,
      this.secrets,
    );
  }
}

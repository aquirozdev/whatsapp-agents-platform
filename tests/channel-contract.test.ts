import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaWhatsAppChannel, parseWhatsAppDeliveryStatuses, parseWhatsAppMessages } from "../src/channels/whatsapp.js";
import type { AgentConfig } from "../src/core/types.js";

const tenant: AgentConfig = {
  schemaVersion: 1,
  tenantId: "t1",
  displayName: "Tenant",
  enabled: true,
  systemPrompt: "test",
  whatsapp: {
    phoneNumberId: "123456789",
    accessTokenSecret: { key: "wa/token" },
    graphApiVersion: "v23.0",
  },
  tools: [],
};

const channel = new MetaWhatsAppChannel({ async get() { return "token"; } });

afterEach(() => vi.unstubAllGlobals());

describe("Meta WhatsApp channel contract", () => {
  it("normalizes text and interactive replies", () => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: {
      metadata: { phone_number_id: "123456789" },
      messages: [{ id: "m1", from: "5931", timestamp: "1760000000", interactive: { button_reply: { id: "yes", title: "Sí" } } }],
    } }] }] });
    const parsed = parseWhatsAppMessages(body);
    expect(parsed[0]?.text).toBe("Sí");
    expect(parsed[0]?.content[0]).toMatchObject({ kind: "interactive_reply", id: "yes" });
    expect(channel.toEnvelope(tenant, channel.parseInbound(body)[0]!).content?.[0]?.kind).toBe("interactive_reply");
  });

  it("normalizes delivery status webhooks", () => {
    const statuses = parseWhatsAppDeliveryStatuses(JSON.stringify({ entry: [{ changes: [{ value: {
      statuses: [{ id: "wamid.out", status: "delivered", timestamp: "1760000000" }],
    } }] }] }));
    expect(statuses[0]).toMatchObject({ providerMessageId: "wamid.out", status: "delivered" });
  });

  it("returns provider delivery receipts and renders rich messages", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.type).toBe("interactive");
      expect(body.interactive.type).toBe("button");
      return new Response(JSON.stringify({ messages: [{ id: "wamid.out" }] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const receipt = await channel.send(tenant, { value: "5931", kind: "phone" }, {
      kind: "interactive",
      body: "Continuar?",
      buttons: [{ id: "yes", title: "Sí" }, { id: "no", title: "No" }],
    });
    expect(receipt.providerMessageId).toBe("wamid.out");
    expect(receipt.status).toBe("accepted");
  });
});

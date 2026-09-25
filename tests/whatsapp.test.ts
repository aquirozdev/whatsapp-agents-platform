import { describe, expect, it } from "vitest";
import { parseWhatsAppMessages } from "../src/channels/whatsapp.js";

describe("WhatsApp parser", () => {
  it("parses text messages", () => {
    const result = parseWhatsAppMessages(JSON.stringify({
      entry: [{ changes: [{ value: { metadata: { phone_number_id: "123" }, messages: [{ id: "wamid.1", from: "593999", timestamp: "1700000000", type: "text", text: { body: "Hola" } }] } }] }],
    }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      phoneNumberId: "123",
      userId: "593999",
      replyTo: "593999",
      replyToType: "phone",
      externalMessageId: "wamid.1",
      text: "Hola",
    });
  });

  it("uses from_user_id as the stable conversation key for WhatsApp usernames", () => {
    const result = parseWhatsAppMessages(JSON.stringify({
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: "123" },
            messages: [{
              id: "wamid.2",
              from_user_id: "US.ENT.11815799212886844830",
              timestamp: "1700000000",
              type: "text",
              text: { body: "Hola desde username" },
            }],
          },
        }],
      }],
    }));

    expect(result[0]).toMatchObject({
      userId: "US.ENT.11815799212886844830",
      replyTo: "US.ENT.11815799212886844830",
      replyToType: "whatsapp_user_id",
    });
  });

  it("keeps BSUID stable while replying to a visible phone number", () => {
    const result = parseWhatsAppMessages(JSON.stringify({
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: "123" },
            messages: [{
              id: "wamid.3",
              from: "593999",
              from_user_id: "EC.ENT.123456789",
              type: "text",
              text: { body: "Hola" },
            }],
          },
        }],
      }],
    }));

    expect(result[0]).toMatchObject({
      userId: "EC.ENT.123456789",
      replyTo: "593999",
      replyToType: "phone",
    });
  });
});

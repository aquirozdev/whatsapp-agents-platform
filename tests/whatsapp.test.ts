import { describe, expect, it } from "vitest";
import { parseWhatsAppMessages } from "../src/channels/whatsapp.js";

describe("WhatsApp parser", () => {
  it("parses text messages", () => {
    const result = parseWhatsAppMessages(JSON.stringify({
      entry: [{ changes: [{ value: { metadata: { phone_number_id: "123" }, messages: [{ id: "wamid.1", from: "593999", timestamp: "1700000000", type: "text", text: { body: "Hola" } }] } }] }],
    }));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ phoneNumberId: "123", userId: "593999", externalMessageId: "wamid.1", text: "Hola" });
  });
});

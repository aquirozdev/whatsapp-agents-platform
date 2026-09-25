import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { sha256, verifyMetaSignature } from "../src/core/security.js";

describe("security helpers", () => {
  it("hashes API keys deterministically", () => {
    expect(sha256("secret")).toBe(sha256("secret"));
    expect(sha256("secret")).not.toBe(sha256("other"));
  });

  it("validates Meta webhook signatures", () => {
    const body = '{"hello":"world"}';
    const secret = "app-secret";
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyMetaSignature(body, signature, secret)).toBe(true);
    expect(verifyMetaSignature(body, "sha256=deadbeef", secret)).toBe(false);
  });
});

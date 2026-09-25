import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hmacSha256(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value, "utf8").digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, "hex");
    const right = Buffer.from(b, "hex");
    return left.length === right.length && timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function verifyMetaSignature(rawBody: string, signature: string | undefined, appSecret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return safeEqualHex(expected, signature.slice("sha256=".length));
}

export function maskDestination(value: string): string {
  if (value.includes("@")) {
    const [local = "", domain = ""] = value.split("@");
    return `${local.slice(0, 2)}***@${domain}`;
  }
  const tail = value.slice(-4);
  return `${"*".repeat(Math.max(4, value.length - 4))}${tail}`;
}

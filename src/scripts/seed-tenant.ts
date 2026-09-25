import { readFile } from "node:fs/promises";
import { PlatformStore } from "../storage/dynamo.js";
import { sha256 } from "../core/security.js";
import type { AgentConfig } from "../core/types.js";
import { validateAgentConfig } from "../core/config-validation.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run seed:tenant -- examples/tenant.example.json [plain-api-key]");
  process.exit(1);
}

const apiKey = process.argv[3];
const config = JSON.parse(await readFile(file, "utf8")) as AgentConfig;
const store = new PlatformStore();
const existing = await store.getTenant(config.tenantId);

if (apiKey) config.apiKeyHash = sha256(apiKey);
else if (!config.apiKeyHash && existing?.apiKeyHash) config.apiKeyHash = existing.apiKeyHash;

if (config.whatsapp) {
  const phoneOwner = await store.getTenantByWhatsAppPhoneNumberId(config.whatsapp.phoneNumberId);
  if (phoneOwner && phoneOwner.tenantId !== config.tenantId) {
    console.error(`WhatsApp phoneNumberId ${config.whatsapp.phoneNumberId} is already assigned to tenant ${phoneOwner.tenantId}.`);
    process.exit(1);
  }
}

const issues = validateAgentConfig(config);
if (issues.length > 0) {
  console.error("Tenant configuration is invalid:");
  for (const issue of issues) console.error(`- ${issue.path}: ${issue.message}`);
  process.exit(1);
}

await store.putTenant(config);
console.log(`Tenant ${config.tenantId} saved as config version ${config.configVersion}.`);
if (apiKey) console.log("API key hash was derived locally; the plaintext key was not stored.");

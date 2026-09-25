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
if (apiKey) config.apiKeyHash = sha256(apiKey);

const issues = validateAgentConfig(config);
if (issues.length > 0) {
  console.error("Tenant configuration is invalid:");
  for (const issue of issues) console.error(`- ${issue.path}: ${issue.message}`);
  process.exit(1);
}

await new PlatformStore().putTenant(config);
console.log(`Tenant ${config.tenantId} saved.`);
if (apiKey) console.log("API key hash was derived locally; the plaintext key was not stored.");

import { readFile } from "node:fs/promises";
import type { AgentConfig } from "../core/types.js";
import { validateAgentConfig } from "../core/config-validation.js";
import { migrateAgentConfig } from "../core/config-migrations.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run validate:tenant -- <tenant.json>");
  process.exit(1);
}

const config = migrateAgentConfig(JSON.parse(await readFile(file, "utf8")) as AgentConfig);
const issues = validateAgentConfig(config);

if (issues.length > 0) {
  console.error(`Invalid tenant configuration (${issues.length} issue(s)):`);
  for (const issue of issues) console.error(`- ${issue.path}: ${issue.message}`);
  process.exit(1);
}

console.log(`Tenant configuration is valid: ${config.tenantId}`);

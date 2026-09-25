import { readFile, writeFile } from "node:fs/promises";
import type { AgentConfig } from "../core/types.js";
import { migrateAgentConfig } from "../core/config-migrations.js";
import { validateAgentConfig } from "../core/config-validation.js";

const file = process.argv[2];
if (!file) {
  console.error("Usage: npm run migrate:tenant -- <tenant.json> [--write]");
  process.exit(1);
}

const original = JSON.parse(await readFile(file, "utf8")) as AgentConfig;
const migrated = migrateAgentConfig(original);
const issues = validateAgentConfig(migrated);
if (issues.length) {
  console.error("Migrated configuration is invalid:");
  for (const issue of issues) console.error(`- ${issue.path}: ${issue.message}`);
  process.exit(1);
}

if (process.argv.includes("--write")) {
  await writeFile(file, JSON.stringify(migrated, null, 2) + "\n", "utf8");
  console.log(`Migrated ${file} to schemaVersion ${migrated.schemaVersion}.`);
} else {
  process.stdout.write(JSON.stringify(migrated, null, 2) + "\n");
}

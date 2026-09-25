import { readFile } from "node:fs/promises";
import type { AgentConfig } from "../core/types.js";
import { migrateAgentConfig } from "../core/config-migrations.js";
import { diffAgentConfig, formatConfigDiff } from "../core/config-diff.js";

const beforeFile = process.argv[2];
const afterFile = process.argv[3];
if (!beforeFile || !afterFile) {
  console.error("Usage: npm run diff:tenant -- <before.json> <after.json>");
  process.exit(1);
}

const before = migrateAgentConfig(JSON.parse(await readFile(beforeFile, "utf8")) as AgentConfig);
const after = migrateAgentConfig(JSON.parse(await readFile(afterFile, "utf8")) as AgentConfig);
console.log(formatConfigDiff(diffAgentConfig(before, after)));

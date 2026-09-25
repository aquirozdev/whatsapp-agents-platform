import type { AgentConfig } from "./types.js";

export interface ConfigDiffEntry {
  path: string;
  before?: unknown;
  after?: unknown;
  change: "added" | "removed" | "changed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function walk(before: unknown, after: unknown, path: string, out: ConfigDiffEntry[]): void {
  if (Object.is(before, after)) return;

  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) walk(before[key], after[key], path ? `${path}.${key}` : key, out);
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after)) out.push({ path, before, after, change: "changed" });
    return;
  }

  if (before === undefined) out.push({ path, after, change: "added" });
  else if (after === undefined) out.push({ path, before, change: "removed" });
  else out.push({ path, before, after, change: "changed" });
}

export function diffAgentConfig(before: AgentConfig, after: AgentConfig): ConfigDiffEntry[] {
  const out: ConfigDiffEntry[] = [];
  walk(before, after, "", out);
  return out.filter((entry) => entry.path !== "apiKeyHash" && !entry.path.endsWith("Secret") && !entry.path.includes("secretHeaders"));
}

export function formatConfigDiff(entries: ConfigDiffEntry[]): string {
  if (entries.length === 0) return "No configuration changes.";
  return entries.map((entry) => {
    const marker = entry.change === "added" ? "+" : entry.change === "removed" ? "-" : "~";
    return `${marker} ${entry.path}`;
  }).join("\n");
}

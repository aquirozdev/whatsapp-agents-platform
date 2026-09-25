import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function tsFiles(root: string): string[] {
  const entries = readdirSync(root);
  return entries.flatMap((entry) => {
    const path = join(root, entry);
    return statSync(path).isDirectory() ? tsFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("architecture boundaries", () => {
  it("keeps platform core and portable adapters free of cloud SDK imports", () => {
    const roots = ["src/core", "src/workflows", "src/tools", "src/ports", "src/channels"];
    const violations: string[] = [];
    for (const root of roots) {
      for (const file of tsFiles(root)) {
        const content = readFileSync(file, "utf8");
        if (/from\s+["'](?:@aws-sdk\/|aws-cdk-lib|@google-cloud\/|cloudflare:)/.test(content)) {
          violations.push(file);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

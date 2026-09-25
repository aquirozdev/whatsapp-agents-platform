import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

async function tsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}

describe("architecture boundaries", () => {
  it("keeps core, workflows and ports free of cloud/model SDK imports", async () => {
    const files = [
      ...(await tsFiles("src/core")),
      ...(await tsFiles("src/workflows")),
      ...(await tsFiles("src/ports")),
    ];
    const forbidden = [
      "@aws-sdk/",
      "aws-cdk",
      "@google-cloud/",
      "cloudflare:",
      "openai",
      "@anthropic-ai/",
    ];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      for (const dependency of forbidden) {
        expect(source, `${file} must not depend on ${dependency}`).not.toContain(dependency);
      }
    }
  });
});

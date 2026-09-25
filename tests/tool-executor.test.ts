import { describe, expect, it } from "vitest";
import type { ToolExecutor } from "../src/ports/tool-executor.js";
import { ToolExecutorRegistry } from "../src/ports/tool-executor.js";

const fake: ToolExecutor = {
  kind: "custom",
  async execute() {
    return { ok: true, data: { value: 1 } };
  },
};

describe("ToolExecutorRegistry", () => {
  it("registers provider-specific tool kinds without changing the core registry", async () => {
    const registry = new ToolExecutorRegistry([fake]);
    expect(registry.has("custom")).toBe(true);
    expect((await registry.get("custom")!.execute({} as never, {} as never, {})).ok).toBe(true);
  });

  it("rejects duplicate executor kinds", () => {
    expect(() => new ToolExecutorRegistry([fake, fake])).toThrow(/already registered/);
  });
});

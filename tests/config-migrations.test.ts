import { describe, expect, it } from "vitest";
import { migrateAgentConfig } from "../src/core/config-migrations.js";
import { diffAgentConfig } from "../src/core/config-diff.js";
import type { AgentConfig } from "../src/core/types.js";

function legacy(): AgentConfig {
  return {
    tenantId: "legacy",
    displayName: "Legacy",
    enabled: true,
    systemPrompt: "hello",
    modelId: "legacy-model",
    whatsapp: {
      phoneNumberId: "123456",
      accessTokenSecretArn: "legacy-secret",
      graphApiVersion: "v23.0",
    },
    tools: [],
  };
}

describe("tenant config lifecycle", () => {
  it("migrates legacy provider-specific fields to schema v1", () => {
    const migrated = migrateAgentConfig(legacy());
    expect(migrated.schemaVersion).toBe(1);
    expect(migrated.model).toEqual({ provider: "bedrock", model: "legacy-model" });
    expect(migrated.whatsapp?.accessTokenSecret).toEqual({ key: "legacy-secret" });
  });

  it("rejects configurations newer than the runtime", () => {
    expect(() => migrateAgentConfig({ ...legacy(), schemaVersion: 999 })).toThrow(/newer than runtime/);
  });

  it("produces secret-safe configuration diffs", () => {
    const before = migrateAgentConfig(legacy());
    const after = { ...before, displayName: "Changed", apiKeyHash: "secret" };
    const paths = diffAgentConfig(before, after).map((entry) => entry.path);
    expect(paths).toContain("displayName");
    expect(paths).not.toContain("apiKeyHash");
  });
});

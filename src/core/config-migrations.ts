import { CURRENT_SCHEMA_VERSION, type AgentConfig } from "./types.js";

export function migrateAgentConfig(input: AgentConfig): AgentConfig {
  const schemaVersion = input.schemaVersion ?? 0;
  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(`Tenant schemaVersion ${schemaVersion} is newer than runtime version ${CURRENT_SCHEMA_VERSION}.`);
  }

  let config: AgentConfig = structuredClone(input);
  if (schemaVersion < 1) {
    config = {
      ...config,
      schemaVersion: 1,
      model: config.model ?? (config.modelId ? { provider: "bedrock", model: config.modelId } : undefined),
      whatsapp: config.whatsapp ? {
        ...config.whatsapp,
        accessTokenSecret: config.whatsapp.accessTokenSecret ??
          (config.whatsapp.accessTokenSecretArn ? { key: config.whatsapp.accessTokenSecretArn } : undefined),
      } : undefined,
    };
  }

  return config;
}

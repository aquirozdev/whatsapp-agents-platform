import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { SecretProvider, SecretReference } from "../../ports/secrets.js";
import { secretKey } from "../../ports/secrets.js";
import { awsClientOptions } from "./client-options.js";

export class AwsSecretsManagerProvider implements SecretProvider {
  private readonly client = new SecretsManagerClient(awsClientOptions());
  private readonly cache = new Map<string, string>();

  async get(reference: SecretReference): Promise<string> {
    const key = secretKey(reference);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const response = await this.client.send(new GetSecretValueCommand({ SecretId: key }));
    const value = response.SecretString ?? (response.SecretBinary ? Buffer.from(response.SecretBinary).toString("utf8") : undefined);
    if (!value) throw new Error(`Secret ${key} has no value.`);
    this.cache.set(key, value);
    return value;
  }
}

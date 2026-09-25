import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { SecretRef } from "../core/types.js";
import type { SecretProvider } from "../ports/secrets.js";

const client = new SecretsManagerClient({});

export class AwsSecretProvider implements SecretProvider {
  private readonly cache = new Map<string, string>();

  async get(ref: SecretRef): Promise<string> {
    const id = ref.key;
    const cached = this.cache.get(id);
    if (cached) return cached;

    const response = await client.send(new GetSecretValueCommand({ SecretId: id }));
    const value = response.SecretString ?? (response.SecretBinary ? Buffer.from(response.SecretBinary).toString("utf8") : undefined);
    if (!value) throw new Error(`Secret ${id} has no value.`);
    this.cache.set(id, value);
    return value;
  }
}

export const awsSecrets = new AwsSecretProvider();

/** @deprecated Inject SecretProvider instead. */
export async function getSecret(id: string): Promise<string> {
  return awsSecrets.get({ key: id });
}

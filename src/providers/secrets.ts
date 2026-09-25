import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});
const cache = new Map<string, string>();

export async function getSecret(arn: string): Promise<string> {
  const cached = cache.get(arn);
  if (cached) return cached;
  const response = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  const value = response.SecretString ?? (response.SecretBinary ? Buffer.from(response.SecretBinary).toString("utf8") : undefined);
  if (!value) throw new Error(`Secret ${arn} has no value.`);
  cache.set(arn, value);
  return value;
}

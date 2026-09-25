export interface AwsClientOptions {
  endpoint?: string;
  region?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

export function awsClientOptions(): AwsClientOptions {
  const endpoint = process.env.AWS_ENDPOINT_URL || process.env.FLOCI_ENDPOINT_URL;
  if (!endpoint) return {};
  return {
    endpoint,
    region: process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1",
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    },
  };
}

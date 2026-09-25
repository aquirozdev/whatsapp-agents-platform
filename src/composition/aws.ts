import type { ModelConfig, SecretRef } from "../core/types.js";
import { AgentRuntime } from "../core/agent-runtime.js";
import { MetaWhatsAppChannel } from "../channels/whatsapp.js";
import { PlatformStore } from "../storage/dynamo.js";
import { AwsSecretProvider } from "../providers/secrets.js";
import { BedrockModelProvider } from "../providers/bedrock.js";
import { OpenAICompatibleModelProvider } from "../providers/openai-compatible.js";
import { ModelRegistry } from "../providers/model-registry.js";
import { AwsOtpDeliveryProvider } from "../providers/aws-otp-delivery.js";
import { OtpService } from "../tools/otp-tools.js";
import { HttpToolExecutor } from "../tools/http-tool.js";
import { DefaultToolExecutor } from "../tools/default-tool-executor.js";

export interface AwsRuntimeComposition {
  store: PlatformStore;
  secrets: AwsSecretProvider;
  runtime: AgentRuntime;
  whatsapp: MetaWhatsAppChannel;
}

function defaultModel(): ModelConfig | undefined {
  const model = process.env.DEFAULT_MODEL_ID?.trim();
  return model ? { provider: "bedrock", model } : undefined;
}

function requiredSecretRef(envName: string): SecretRef {
  const value = process.env[envName]?.trim();
  if (!value) throw new Error(`${envName} is required.`);
  return { key: value };
}

let singleton: AwsRuntimeComposition | undefined;

export function composeAwsRuntime(): AwsRuntimeComposition {
  if (singleton) return singleton;

  const store = new PlatformStore();
  const secrets = new AwsSecretProvider();
  const models = new ModelRegistry([
    new BedrockModelProvider(),
    new OpenAICompatibleModelProvider(secrets),
  ]);
  const otpDelivery = new AwsOtpDeliveryProvider(process.env.OTP_EMAIL_FROM?.trim() || undefined);
  const otp = new OtpService(store, secrets, otpDelivery, requiredSecretRef("OTP_HMAC_SECRET_ARN"));
  const tools = new DefaultToolExecutor(new HttpToolExecutor(secrets), otp);
  const runtime = new AgentRuntime(store, models, tools, defaultModel());
  const whatsapp = new MetaWhatsAppChannel(secrets);

  singleton = { store, secrets, runtime, whatsapp };
  return singleton;
}

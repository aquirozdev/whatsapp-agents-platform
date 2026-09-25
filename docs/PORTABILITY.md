# Portability contract

The platform is a provider-neutral conversational runtime with AWS as the first deployment adapter.

## Stable core

The following layers must not import cloud SDKs:

- `src/core`
- `src/workflows`
- `src/tools`
- `src/ports`
- `src/channels`

CI enforces this boundary.

The core owns business semantics: tenants, conversations, deterministic workflows, policies, tool execution and model orchestration.

## Ports

Provider differences are hidden behind small contracts:

- `ModelProvider`: model inference and tool calling.
- `PlatformStorePort`: tenant versions, conversation state, consent, OTP state, dedupe and audit.
- `TurnDispatcher`: at-least-once dispatch with a conversation ordering/serialization key.
- `SecretProvider`: logical secret references.
- `OtpDeliveryPort`: built-in OTP delivery.
- `ChannelAdapter`: inbound normalization and outbound channel delivery.
- `ToolExecutor`: pluggable integration kinds such as HTTP today and MCP/SOAP/etc. later without changing the policy/tool registry.

Adapters may implement those contracts differently. The contract describes required semantics, not a specific cloud resource.

## AWS adapter

The current deployment uses:

- Lambda / API Gateway entrypoints,
- SQS FIFO for ordered conversation dispatch,
- DynamoDB for state and immutable tenant-config versions,
- Secrets Manager,
- Bedrock Converse or an OpenAI-compatible model API,
- SNS/SES for optional built-in OTP.

These choices are not part of the domain model.

## Future deployment adapters

A GCP implementation can map the same ports to Cloud Run/Functions, Pub/Sub ordering keys, Firestore, Secret Manager and Vertex or another model provider. Model selection remains independent from deployment cloud.

A Cloudflare implementation should not pretend Queues are FIFO. A conversation-scoped Durable Object is a better implementation of the required serialization guarantee.

## Tenant configuration portability

Provider-neutral specs should prefer logical references:

```json
{
  "model": { "provider": "bedrock", "model": "..." },
  "whatsapp": {
    "phoneNumberId": "...",
    "accessTokenSecret": { "key": "tenant/customer/whatsapp-token" },
    "graphApiVersion": "v23.0"
  }
}
```

Legacy `modelId` and `accessTokenSecretArn` are accepted during migration but should not be introduced in new specs.

## Versioning

Every successful publish creates an immutable `CONFIG#vN` record and updates the active `CONFIG` pointer atomically. Active workflows pin their configuration version so a publish cannot change a transaction midway.

## Concurrency

Conversation writes use optimistic revisions. The synchronous Web/API path additionally acquires a short conversation lease before running tools or the model, preventing concurrent turns from racing through side effects.

WhatsApp remains serialized by the dispatcher ordering key.

## Adding a provider

A new provider should require:

1. one adapter implementing an existing port (or one registered `ToolExecutor` for a new integration kind);
2. adapter-focused tests;
3. no changes to workflow definitions, policy code or customer-specific branches.

If a provider requires domain changes, first verify that the missing concept is a true platform capability rather than a vendor-specific feature.

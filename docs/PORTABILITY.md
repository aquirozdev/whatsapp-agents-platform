# Portability model

The platform is designed around business semantics, not cloud resources. The reference deployment is AWS, but the core runtime must remain portable.

## Three layers

1. **Core/application** — agent orchestration, workflows, policies, tenant configuration and tool authorization.
2. **Ports/adapters** — models, persistence, secrets, ordered turn dispatch, channels and OTP delivery.
3. **Deployment** — Lambda/API Gateway/SQS/DynamoDB today; another cloud may use different primitives while implementing the same port semantics.

The platform deliberately does **not** define a generic `CloudProvider` interface. AWS, Google Cloud and Cloudflare have different primitives and guarantees. We abstract the guarantees the runtime needs.

## Required semantics

### Ordered turn dispatch

A `TurnDispatcher` must provide:

- at-least-once delivery;
- serialization for the same conversation ordering key;
- retries;
- a recoverable failure path.

The AWS adapter uses SQS FIFO. A GCP adapter can use Pub/Sub ordering keys. A Cloudflare deployment should use a serialization primitive such as a Durable Object rather than assuming Cloudflare Queues are FIFO.

### Conversation persistence

A store must support optimistic/serialized conversation updates. The AWS adapter uses a revision field plus DynamoDB conditional writes.

The runtime commits a conversation state and a durable `prepared` turn event atomically. If outbound delivery fails after the business turn executed, a retry resumes the prepared outbound response instead of re-running transactional tools.

### Configuration versions

Publishing a tenant creates an immutable `CONFIG#<version>` record and updates the active `CONFIG` snapshot. A workflow records the config version that started it. Active workflows therefore continue on their original definition even if a new tenant version is published.

### Secrets

Tenant specs use logical `SecretRef` objects:

```json
{ "key": "core-api/authorization" }
```

The deployment secret adapter resolves that key. AWS accepts a Secrets Manager name or ARN; another deployment can map the same key to its native secret store.

### Models

The model contract represents only platform semantics:

- text messages;
- tool definitions;
- tool calls;
- tool results;
- usage metadata.

Provider-specific request/response formats stay in adapters. The current runtime includes:

- `BedrockModelProvider`;
- `OpenAICompatibleModelProvider`.

A tenant selects its provider independently from its cloud deployment.

## Portable tenant example

```json
{
  "tenantId": "customer-a",
  "displayName": "Customer A",
  "enabled": true,
  "systemPrompt": "You are the customer assistant.",
  "model": {
    "provider": "bedrock",
    "model": "MODEL_ID"
  },
  "whatsapp": {
    "phoneNumberId": "123456789012345",
    "accessTokenSecret": { "key": "whatsapp/access-token" },
    "graphApiVersion": "v26.0"
  },
  "tools": []
}
```

No ARN, project ID, region, queue URL or cloud-specific credential belongs in the portable tenant spec.

## Portable tool schema

Tool schemas intentionally use a conservative subset that maps across model providers:

- `type`
- `properties`
- `required`
- `additionalProperties`
- `enum`
- `items`
- `description`
- numeric/string/array size constraints

Configuration validation rejects unsupported schema keywords before publication.

## Deployment profiles

The same core can support:

### AWS

```text
API Gateway -> Lambda ingress -> SQS FIFO -> Lambda worker
                                      |
                         DynamoDB / Secrets Manager
                                      |
                           Bedrock or external model
```

### Google Cloud

A future adapter can map to Cloud Run/Functions, Pub/Sub ordering keys, Firestore/Spanner/Postgres, Secret Manager and Vertex or an external model provider.

### Cloudflare

A future deployment should map per-conversation serialization to Durable Objects and use Workers plus suitable persistence/secrets. It should not copy the AWS topology mechanically.

## Architecture guard

CI scans `src/core`, `src/workflows` and `src/ports` and rejects imports from AWS, GCP, Cloudflare, OpenAI or Anthropic SDKs. Provider SDKs belong in adapters/composition only.

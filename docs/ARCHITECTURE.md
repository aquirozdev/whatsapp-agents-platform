# Architecture

![WhatsApp Agents Platform v1 architecture](assets/architecture-v1.png)

> The deployment remains intentionally small. The new workflow runtime is a TypeScript module inside the existing Worker Lambda, not a new AWS service.

## Objective

Keep one generic runtime small enough for a small engineering team to own while supporting regulated, transactional use cases without customer-specific forks.

The platform separates eight concepts:

1. **Tenant** — customer configuration and credentials.
2. **Channel** — WhatsApp or Web/API transport.
3. **Agent** — conversational reasoning and workflow routing through a `ModelProvider`.
4. **Workflow** — deterministic transactional sequence.
5. **Policy** — deterministic authorization checks outside the model.
6. **Tool** — customer/system action executed by application code.
7. **Capability** — metadata grouping reusable tools/workflows for product configuration.
8. **Conversation** — history, verification, workflow and handoff state.

## Provider-neutral boundary

Business semantics live in `core`, `workflows`, `tools` and `ports`. Those layers do not import cloud SDKs. Deployment-specific implementations live behind ports:

| Port | AWS adapter today | Required semantic |
|---|---|---|
| `ModelProvider` | Bedrock Converse | messages + tool calls/results |
| `PlatformStorePort` | DynamoDB | durable state, conditional revisions, config versions |
| `TurnDispatcher` | SQS FIFO | at-least-once delivery + per-conversation serialization |
| `SecretProvider` | Secrets Manager | logical secret resolution |
| `OtpDeliveryPort` | SNS / SES | delivery only; verification rules stay in the runtime |
| `ObservabilityPort` | CloudWatch EMF / structured logs | low-cardinality metrics + portable spans/events |

A future cloud adapter may use different managed services as long as it preserves these semantics.

## AWS components

| Component | Responsibility |
|---|---|
| API Gateway HTTP API | Public HTTPS entrypoint |
| Ingress Lambda | Meta verification/signature validation, tenant resolution, queue publish |
| SQS FIFO | Buffering, retries and ordering by tenant + conversation |
| Worker Lambda | Agent mode, workflow mode, tools, policies, synchronous API |
| DynamoDB | Tenant config, conversation/workflow state, consent, OTP, processed-event dedupe, audit |
| Secrets Manager | Meta secrets, WhatsApp tokens and tenant integration credentials |
| Bedrock Runtime | Conversational inference and workflow routing |
| SNS / SES | Optional built-in OTP delivery adapters |

No additional service is required to add workflows.

## WhatsApp path

```text
Meta Cloud API
      |
      v
API Gateway
      |
      v
Ingress Lambda
  - verify signature
  - resolve phone_number_id -> tenant
  - enqueue
      |
      v
SQS FIFO
  MessageGroupId = tenantId:userId
      |
      v
Worker Lambda
  - processed-event check
  - load tenant + conversation
  - agent OR active workflow
  - policies + tools
  - persist state/audit
  - send text/document responses
      |
      v
Meta Send Message API
```

The event source uses `batchSize: 1`. This deliberately simplifies FIFO failure semantics: a failed record cannot allow a later record from the same invocation to overtake it, while Lambda can still scale across different FIFO message groups.

The conversation revision and a durable processed-event record (including outbound messages) are committed atomically. Outbound delivery happens afterward. If delivery fails, a retry replays the persisted outbound payload instead of re-running the model, workflow or transactional tools. Delivery is then marked separately.

This removes the dangerous retry path where the same inbound turn could advance a workflow twice. As with any external HTTP messaging API, a crash after the provider accepts a message but before the delivery marker is persisted can still produce an ambiguous delivery; transactional customer APIs must therefore continue to honor idempotency keys.

## Web/API path

`POST /v1/chat` invokes the Worker synchronously and uses exactly the same `AgentRuntime`.

Web clients receive structured outbound messages. A document workflow therefore returns a document descriptor even when the caller is not WhatsApp.

## Agent mode vs workflow mode

```text
Inbound message
      |
      v
Conversation has active workflow?
      |
   +--+--+
   |     |
  yes    no
   |     |
   v     v
Workflow  ModelProvider
Runtime       |
          (Bedrock adapter today)
   |          +-- answer normally
   |          +-- call agent-exposed tool
   |          `-- call start_workflow
   |                        |
   +------------------------+
            |
            v
      Policy + Tools
```

### Agent mode

The selected `ModelProvider` receives only tools whose `exposure` is `agent` or `both`, plus the platform-reserved `start_workflow` tool when workflows exist.

The model requests tools; application code executes them. The model never receives credentials and never performs the upstream HTTP call itself. Bedrock Converse is the current AWS model adapter, but the orchestration loop is provider-neutral.

### Workflow mode

After `start_workflow`, the LLM is removed from the transaction path. User replies are processed by deterministic TypeScript steps until completion, cancellation or expiry.

Workflow primitives are documented in [WORKFLOWS.md](WORKFLOWS.md).

## Why no general agent framework

The platform only requires a portable messages + tool-calling contract for free-form conversation and routing. A small `ModelProvider` port is enough; provider adapters translate that contract to Bedrock, OpenAI, Vertex or another model API.

The deterministic workflow runtime handles transactional sequencing without introducing another agent runtime. A long-running external workflow engine can still be added later for multi-day approvals; it is not required for conversational transactions lasting minutes.

## Tool boundary

```text
Agent / Workflow
      |
      v
ToolRegistry
      |
      +-- exposure check
      +-- verification policy
      +-- consent policy
      |
      v
Configured integration
      |
   +-- HTTP
   +-- built-in OTP
   `-- handoff
```

HTTP tools support bounded timeouts, Secrets Manager headers and an optional idempotency header populated with the inbound message ID.

## DynamoDB model

| PK | SK | Entity |
|---|---|---|
| `TENANT#<tenantId>` | `CONFIG` | Active tenant config pointer/snapshot |
| `TENANT#<tenantId>` | `CONFIG#v<N>` | Immutable tenant config version |
| `TENANT#<tenantId>#CONV#<channel>#<conversationId>` | `STATE` | Versioned conversation + active workflow + verification |
| `TENANT#<tenantId>#CONV#<channel>#<conversationId>` | `LEASE` | Short lease for synchronous turn serialization |
| `TENANT#<tenantId>#SUBJECT#<subjectId>` | `CONSENT#<policyId>#<version>` | Durable consent |
| `TENANT#<tenantId>#OTP#<challengeId>` | `CHALLENGE` | Built-in OTP challenge |
| `EVENT#<externalMessageId>` | `EVENT` | Processed event, durable outbound, receipts and latest delivery status |
| `DELIVERY#<providerMessageId>` | `DELIVERY` | Short-lived delivery reconciliation index |
| `TENANT#<tenantId>#TOOL_RATE#...` | `WINDOW#...` | Distributed per-tool quota window |
| `TENANT#<tenantId>#AUDIT#YYYY-MM-DD` | `<timestamp>#<uuid>` | Audit event |

GSI1 maps WhatsApp phone numbers:

```text
gsi1pk = WA_PHONE#<phoneNumberId>
gsi1sk = TENANT#<tenantId>
```

Workflow state stays inside the conversation item, so no workflow database/service is added. Conversation writes use optimistic revisions. When a workflow starts it pins the active tenant `configVersion`, so publishing a new agent configuration cannot change an in-flight transaction.

## Multi-tenancy and dedicated mode

Shared mode uses one stack and tenant-scoped keys/config. Dedicated mode deploys the same CDK stack to a customer-owned account or isolated environment and seeds only that customer's configuration.

No domain-specific class or Lambda is required.

## Failure behavior

- Ingress responds after queueing.
- SQS retries worker failures.
- DLQ receives a record after five failed receives.
- FIFO batch size is 1 for simple ordering/failure behavior.
- Conversation state + processed inbound result are committed atomically.
- Failed outbound delivery replays the durable outbound result without re-running the transaction.
- Event dedupe is durable.
- Side-effecting HTTP tools can forward an idempotency key to the upstream API.
- HTTP timeouts are bounded.
- Bedrock tool rounds are bounded.
- Workflow steps have a 50-step internal guard and configurable session TTL.

## Extension seams

The current boundaries support later addition of:

- knowledge/RAG tools,
- admin portal,
- human inbox,
- OIDC/Cognito and RBAC,
- customer-managed KMS keys,
- private/VPC integrations,
- additional channels,
- durable multi-day workflow engines,
- immutable audit export.


## Portability rule

Cloud portability is implemented at semantic boundaries, not by pretending every cloud has equivalent products. For example, AWS uses SQS FIFO for per-conversation ordering; another deployment may implement the same `TurnDispatcher` serialization guarantee with a different primitive.

See [PORTABILITY.md](PORTABILITY.md) and [TESTING.md](TESTING.md).

## Operational contracts

Channel delivery is two-phase: the runtime first commits conversation state plus durable outbound, then the channel returns an acceptance receipt. Provider delivery webhooks update the durable status independently. Replays skip outbound entries that already have persisted acceptance receipts, reducing duplicates without introducing a separate outbox service.

Observability follows the same ports-and-adapters rule as storage/models. The core emits portable metrics/spans; the AWS adapter serializes them as CloudWatch Embedded Metric Format and structured JSON. Metric dimensions stay deliberately low-cardinality.

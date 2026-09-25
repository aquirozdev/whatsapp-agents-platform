# Architecture

![WhatsApp Agents Platform v1 architecture](assets/architecture-v1.png)

> The deployment remains intentionally small. The new workflow runtime is a TypeScript module inside the existing Worker Lambda, not a new AWS service.

## Objective

Keep one generic runtime small enough for a small engineering team to own while supporting regulated, transactional use cases without customer-specific forks.

The platform separates eight concepts:

1. **Tenant** — customer configuration and credentials.
2. **Channel** — WhatsApp or Web/API transport.
3. **Agent** — conversational reasoning and workflow routing through Bedrock.
4. **Workflow** — deterministic transactional sequence.
5. **Policy** — deterministic authorization checks outside the model.
6. **Tool** — customer/system action executed by application code.
7. **Capability** — metadata grouping reusable tools/workflows for product configuration.
8. **Conversation** — history, verification, workflow and handoff state.

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

A message is marked processed **after** runtime execution and outbound delivery succeeds. This lets SQS retries actually retry failed work; marking before execution would incorrectly suppress retries.

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
Workflow  Bedrock Converse
Runtime       |
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

Bedrock receives only tools whose `exposure` is `agent` or `both`, plus the platform-reserved `start_workflow` tool when workflows exist.

Amazon Bedrock client-side tool use means the model requests a tool and application code executes it. The model never receives credentials and never performs the HTTP call itself.

### Workflow mode

After `start_workflow`, the LLM is removed from the transaction path. User replies are processed by deterministic TypeScript steps until completion, cancellation or expiry.

Workflow primitives are documented in [WORKFLOWS.md](WORKFLOWS.md).

## Why direct Bedrock Converse

The platform needs model conversation, routing and client-side tool use. Converse already provides the model/tool protocol. The deterministic workflow runtime handles transactional sequencing without introducing a general agent framework or another runtime service.

A long-running external workflow engine can still be added later for multi-day approvals; it is not required for conversational transactions lasting minutes.

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
| `TENANT#<tenantId>` | `CONFIG` | Tenant config, tools, workflows, capabilities |
| `TENANT#<tenantId>#CONV#<channel>#<conversationId>` | `STATE` | Conversation + active workflow + verification |
| `TENANT#<tenantId>#SUBJECT#<subjectId>` | `CONSENT#<policyId>#<version>` | Durable consent |
| `TENANT#<tenantId>#OTP#<challengeId>` | `CHALLENGE` | Built-in OTP challenge |
| `EVENT#<externalMessageId>` | `EVENT` | Successfully processed event |
| `TENANT#<tenantId>#AUDIT#YYYY-MM-DD` | `<timestamp>#<uuid>` | Audit event |

GSI1 maps WhatsApp phone numbers:

```text
gsi1pk = WA_PHONE#<phoneNumberId>
gsi1sk = TENANT#<tenantId>
```

Workflow state stays inside the conversation item, so no workflow database/service is added.

## Multi-tenancy and dedicated mode

Shared mode uses one stack and tenant-scoped keys/config. Dedicated mode deploys the same CDK stack to a customer-owned account or isolated environment and seeds only that customer's configuration.

No domain-specific class or Lambda is required.

## Failure behavior

- Ingress responds after queueing.
- SQS retries worker failures.
- DLQ receives a record after five failed receives.
- FIFO batch size is 1 for simple ordering/failure behavior.
- Event dedupe is persisted after success.
- Side-effecting HTTP tools can forward an idempotency key to the upstream API.
- HTTP timeouts are bounded.
- Bedrock tool rounds are bounded.
- Workflow steps have a 50-step internal guard and configurable session TTL.

## Extension seams

The current boundaries support later addition of:

- knowledge/RAG tools,
- admin portal + config versioning,
- human inbox,
- OIDC/Cognito and RBAC,
- customer-managed KMS keys,
- private/VPC integrations,
- additional channels,
- durable multi-day workflow engines,
- immutable audit export.

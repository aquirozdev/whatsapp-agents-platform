# WhatsApp Agents Platform

A small, multi-tenant conversational-agent runtime with provider ports for models, state, secrets, ordered dispatch and channels. The reference deployment uses AWS serverless services, **WhatsApp Cloud API**, and a synchronous **Web/API** channel.

The platform is intentionally customer-agnostic: one codebase, one AWS stack, many tenants. Customer behavior lives in configuration — prompts, tools, deterministic workflows, capabilities, policies and secrets — instead of forks such as `if (tenant === "bank-x")`.

## What is included

- Official Meta WhatsApp Cloud API webhook + outbound text/document messages.
- Multi-tenant resolution by WhatsApp `phone_number_id`.
- Synchronous REST chat endpoint for web/app integrations.
- Provider-neutral model runtime with Amazon Bedrock and OpenAI-compatible adapters, both using client-side tool execution.
- Generic HTTP integrations with secret headers, bounded timeouts, runtime JSON-schema input validation and optional idempotency headers.
- Tool exposure control: `agent`, `workflow`, or `both`.
- Deterministic workflow runtime for transactional processes.
- Durable versioned consent records.
- OTP through built-in SNS/SES tools or customer-owned start/verify APIs, with attempt limits and request cooldowns.
- Policy checks outside the LLM.
- Deterministic selections, confirmations, branching and rendering.
- Document delivery through the current WhatsApp channel.
- Human handoff state.
- FIFO queue per conversation.
- DynamoDB state, audit, OTP, immutable tenant config versions, optimistic conversation concurrency and durable turn/outbound records.
- Portable secret references resolved by the deployment secret adapter (AWS Secrets Manager in the reference deployment).
- AWS CDK infrastructure in TypeScript, with API access logs, detailed metrics and stage throttling.
- Config validation, unit tests, CI and OpenAPI.
- Zero-framework local admin for editing, validating and publishing tenant JSON.

## Runtime architecture

![WhatsApp Agents Platform v1 architecture](docs/assets/architecture-v1.png)

There are still only **two Lambda functions**:

1. **Ingress** — validates Meta requests, resolves the tenant and queues WhatsApp events.
2. **Worker** — runs agent mode or workflow mode, policies, tools and the synchronous Web/API endpoint.

```text
WhatsApp -> API Gateway -> Ingress Lambda -> SQS FIFO -> Worker Lambda
                                                     |
Web/App  -> API Gateway ---------------------------->|
                                                     |
                           +-------------------------+----------------------+
                           |                         |                      |
                    ModelProvider             Workflow Runtime         Tool Registry
                 Bedrock / OpenAI-*              deterministic          HTTP / OTP
                           |                         |                      |
                           +-------------------------+----------------------+
                                                     |
                                             Policy / DynamoDB
```

The LLM routes normal conversation and can select a configured workflow through the reserved `start_workflow` tool. Once a workflow starts, the LLM is removed from the transactional control path until that process completes, expires or is cancelled.

See [Architecture](docs/ARCHITECTURE.md) and [Deterministic workflows](docs/WORKFLOWS.md).

## Portability boundaries

The product core does not import cloud or model SDKs. It depends on small contracts under `src/ports/`:

- `ModelProvider` — model/tool-call protocol.
- `PlatformStorePort` — tenant, conversation, consent, verification, audit and atomic turn persistence.
- `TurnDispatcher` — at-least-once delivery with per-conversation serialization.
- `SecretProvider` — logical secret references.
- `ToolExecutor` — integration execution behind policy/schema enforcement.
- `OutboundChannel` — outbound transport.
- `OtpDeliveryProvider` — built-in OTP delivery.

AWS is composed in `src/composition/aws.ts`; changing cloud or model provider does not change workflow definitions or customer business logic. Architecture-boundary tests fail CI if cloud/model SDK imports leak into core/workflows/ports.

See [Portability](docs/PORTABILITY.md).

## Why this stays agnostic

A tenant can add a new use case by composing generic primitives:

```text
consent
  -> collect
  -> verification
  -> tool
  -> select
  -> confirm
  -> branch
  -> render / render_list
  -> deliver
  -> end
```

A bank balance flow, insurance claim intake, appointment booking or order lookup uses the same runtime. Domain-specific behavior belongs in tenant tools and workflow configuration.

A regulated financial use case is represented by an **anonymous reference tenant**, not customer-specific core code:

- [Reference mapping](docs/REFERENCE-FINANCIAL.md)
- [Reference tenant JSON](examples/financial-institution.reference.json)

Customer RFCs and derived confidential details must not be committed to this public repository.

## Prerequisites

- Node.js 22+
- AWS CLI authenticated to the target account
- AWS CDK bootstrap completed
- Amazon Bedrock model/inference-profile access in the selected region
- Meta Developer app + WhatsApp Business Account
- Optional SES/SNS setup when using the built-in OTP delivery adapter

## Install and validate

```bash
npm install
npm run typecheck
npm test
npm run synth -- -c stage=test -c defaultModelId=dummy-model
npm run validate:tenant -- examples/financial-institution.reference.json
```

## Deploy

```bash
npx cdk bootstrap
npm run deploy -- \
  -c stage=dev \
  -c defaultModelId='YOUR_BEDROCK_MODEL_OR_INFERENCE_PROFILE_ID' \
  -c otpEmailFrom='no-reply@example.com'
```

The stack outputs the API URL, DynamoDB table, queue URL and platform secret ARNs.

See [Deployment](docs/DEPLOYMENT.md).

## Configure tenants locally

JSON remains the source of truth. The optional local admin has no React/Next.js/database and is not deployed to AWS:

```bash
npm run admin
# open http://127.0.0.1:4173
```

It edits files under `tenants/`, validates them with the same runtime rules and can publish the selected config to DynamoDB using your current AWS credentials. The plaintext API key is only hashed before publication and is never written to the tenant JSON.

Reusable starting points live in `templates/`:

- `minimal.json`
- `whatsapp-support.json`
- `secure-http-workflow.json`

You can also work entirely from CLI; the admin is convenience, not infrastructure.

## Add a tenant

1. Store WhatsApp and upstream integration credentials in Secrets Manager.
2. Copy an example tenant JSON.
3. Replace service/model/channel placeholders.
4. Seed it:

```bash
TABLE_NAME=<stack-table-name> \
AWS_REGION=<region> \
npm run seed:tenant -- ./tenant.json 'a-long-random-api-key'
```

The seeding CLI validates tool names, workflow references, branch targets and capability references before writing configuration. The plaintext REST API key is hashed locally and is not stored.

## Web/API channel

```bash
curl -X POST "$API_URL/v1/chat" \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: cooperativa-demo' \
  -H 'x-api-key: a-long-random-api-key' \
  -d '{"userId":"customer-123","message":"Quiero consultar mi saldo"}'
```

A workflow-capable response includes both a compatibility `reply` string and structured `messages`:

```json
{
  "reply": "Ingrese su identificación.",
  "messages": [
    { "kind": "text", "text": "Ingrese su identificación." }
  ],
  "conversationId": "customer-123",
  "workflow": {
    "id": "account-balance",
    "status": "active"
  }
}
```

## Tools

Tools integrate customer systems without adding AWS services.

```json
{
  "name": "get_account_balance",
  "kind": "http",
  "exposure": "workflow",
  "requiresVerification": "otp",
  "requiresConsents": [
    { "policyId": "personal-data", "version": "2026-01" }
  ],
  "description": "Read a verified customer's balance.",
  "inputSchema": { "type": "object" },
  "http": {
    "method": "POST",
    "url": "https://core.example.com/accounts/balance",
    "secretHeaders": {
      "Authorization": { "key": "core-api/authorization" }
    },
    "bodyTemplate": { "accountId": "{{accountId}}" },
    "idempotencyHeader": "Idempotency-Key"
  }
}
```

A workflow-only tool is never advertised to the model in free agent mode.

See [Tools](docs/TOOLS.md).

## Consent, verification and transactional safety

Security is enforced in TypeScript, not by prompt instructions.

- Consent is stored by tenant + subject + policy + version.
- Built-in OTP challenges are bound to tenant + user + conversation, HMAC-hashed, expiring and one-time.
- Customer-owned OTP is integrated as workflow start/verify tools.
- Protected tools independently require valid verification/consent.
- Verification can be bound to an authoritative customer/subject ID.
- Active workflow inputs are kept out of free-form LLM history.
- Transactional workflow data is cleared on terminal states by default.
- Transactional tools can be workflow-only.
- Financial values can be rendered deterministically instead of rewritten by the LLM.
- A side-effecting integration can receive the inbound message ID through `idempotencyHeader`.

See [Security](docs/SECURITY.md).

## Human handoff

The `human_handoff` built-in changes a conversation to `human`. While in human mode the AI runtime remains silent.

Return it to AI mode:

```bash
curl -X POST "$API_URL/v1/conversations/whatsapp/<conversation-id>/mode" \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: cooperativa-demo' \
  -H 'x-api-key: a-long-random-api-key' \
  -d '{"mode":"ai"}'
```

## Design principles

- **Configuration over customer forks.**
- **LLM for language/routing; deterministic code for transactions.**
- **Tools are the integration boundary.**
- **Policies are outside the prompt.**
- **Channels are transport adapters.**
- **Few AWS services.**
- **Official WhatsApp API only.**
- **Same application for shared or dedicated deployments.**

## Repository map

```text
src/
  admin/          optional localhost-only JSON editor/publisher
  channels/       WhatsApp parsing and outbound adapters
  core/           types, policies, tool registry, config validation
  workflows/      deterministic workflow runtime
  functions/      Lambda entrypoints
  ports/          provider-neutral runtime contracts
  providers/      model, queue, secrets and cloud adapters
  composition/    deployment composition roots
  storage/        DynamoDB persistence
  tools/          HTTP and built-in OTP tools
  scripts/        tenant seeding CLI
infra/            AWS CDK stack
docs/             architecture, workflows, security, deployment and operations
templates/        reusable vertical-neutral tenant starting points
examples/         generic and reference tenant configs
tenants/          local customer configs (gitignored by default)
tests/            unit tests
openapi.yaml      HTTP API contract
```

## Product scope

This repository is both the deployable runtime and a small local configuration toolkit. Avoid adding a hosted control plane unless a real customer requirement justifies it. Git + JSON + CI provide configuration review/version history; the localhost admin is only an editing/publishing convenience.

See [Roadmap](docs/ROADMAP.md) and [Production readiness](docs/PRODUCTION-READINESS.md).

## License

MIT.

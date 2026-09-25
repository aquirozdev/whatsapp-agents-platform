# Product roadmap

The default rule is **keep the platform small**. Add a service only when a real customer requirement cannot be handled cleanly by JSON, an adapter or the existing two-Lambda runtime.

## Core — implemented

The runtime is provider-portable through explicit model/store/secret/dispatcher/tool/channel ports. AWS remains the reference deployment, not a core dependency.

- official WhatsApp Cloud API
- Web/API chat
- Bedrock Converse
- multi-tenancy
- deterministic transactional workflows
- agent/workflow tool exposure
- JSON Schema validation for tool inputs
- consent and identity-bound OTP
- customer-owned or built-in OTP
- generic HTTP integrations
- confirmation/selection/branching/rendering/document delivery
- human handoff primitive
- audit/state
- SQS FIFO + DLQ
- DynamoDB + PITR
- Secrets Manager
- serverless CDK
- API access logs, metrics and throttling
- CI and tenant validation
- reusable JSON templates
- localhost-only JSON admin/publisher

## Configuration model

Do not build a hosted admin platform by default.

Preferred operating model:

```text
template
   ↓
tenant.json
   ↓
local validator/admin
   ↓
Git / CI (when desired)
   ↓
publish to DynamoDB
   ↓
same runtime
```

Git is enough for configuration history and review for many deployments. Customer secrets stay in Secrets Manager, never in JSON.

## Next improvements that preserve simplicity

Prioritize these when a concrete integration needs them:

- more reusable connector templates (REST/SOAP/GraphQL)
- richer WhatsApp outbound messages (templates, buttons, lists, media)
- optional `search_knowledge` tool behind a small KnowledgeProvider interface
- local conversation inspection/export tooling
- deployment presets for shared vs dedicated AWS accounts
- stronger per-tool scopes/rate limits
- PII redaction hooks

These are adapters/modules, not new always-on services.

## Optional enterprise profiles

Add only when contracted requirements demand them:

- customer-managed KMS keys
- VPC/private connectivity
- immutable centralized audit export
- WAF/REST API edge profile
- OIDC/SSO for a hosted operator console
- dedicated security/compliance evidence
- durable long-running workflow engine

The built-in workflow engine remains for conversational transactions lasting minutes. Use Step Functions/Temporal only when a process truly requires multi-hour/day waits, callbacks, external approvals or distributed compensation.

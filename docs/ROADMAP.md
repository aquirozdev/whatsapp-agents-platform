# Product roadmap

The core should remain small. Add product layers when they improve onboarding, operations or a real enterprise requirement.

## Phase 1 — platform core

Implemented:

- WhatsApp Cloud API
- Web/API chat
- Bedrock Converse
- multi-tenancy
- agent/workflow tool exposure
- deterministic workflow runtime
- consent
- built-in or customer-owned OTP
- generic HTTP tools
- confirmation/selection/branching/rendering/document delivery
- handoff primitive
- audit/state
- serverless CDK
- API access logs, detailed metrics and stage throttling
- runtime JSON-schema validation for tool inputs
- built-in OTP request cooldown
- config validation and CI

## Phase 2 — operator product

- Next.js admin portal
- OIDC/Cognito
- RBAC: platform admin / tenant admin / operator / auditor
- tenant editor
- tool editor
- workflow editor
- capability toggles
- secret onboarding flow
- conversation/handoff inbox
- audit viewer
- config versioning + publish + rollback

The portal should remain a control plane. Runtime policy enforcement stays in backend TypeScript.

## Phase 3 — knowledge and integration catalog

- `search_knowledge` tool
- Bedrock Knowledge Bases or pluggable KnowledgeProvider
- file ingestion
- REST/SOAP/GraphQL connector templates
- selected MCP adapters
- CRM/core-banking/insurance templates
- richer response adapters
- interactive WhatsApp list/button rendering

## Phase 4 — enterprise profile

- customer-managed KMS keys
- dedicated-account deployment preset
- VPC/private integration
- immutable centralized audit export
- WAF/edge hardening
- OIDC federation/enterprise SSO
- per-tool scopes/rate limits
- PII redaction and retention
- security/compliance evidence pack

## Phase 5 — durable long-running processes

The built-in workflow engine is intentionally for conversational transactions lasting minutes.

Use a durable external engine only when a process requires:

- waits across hours/days,
- external callbacks,
- human approvals outside the chat session,
- distributed compensation,
- resumability independent of the conversation item.

Possible adapters include Step Functions or Temporal behind the existing workflow/tool boundary.

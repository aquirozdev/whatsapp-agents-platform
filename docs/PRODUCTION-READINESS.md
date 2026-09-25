# Production readiness

This document separates what the platform **already implements** from what must still be decided for a specific production customer.

The default stack is intentionally small. It is appropriate for pilots, internal systems and many production workloads, but a bank or insurer should still apply its own security, compliance, networking and operational controls.

## Current baseline

Implemented in the platform core:

- official Meta WhatsApp Cloud API webhook and outbound messaging;
- multi-tenant tenant resolution by Meta `phone_number_id`;
- Bedrock Converse with client-side tool execution;
- deterministic transactional workflows outside the LLM;
- runtime JSON Schema validation for every tool input;
- workflow-only tool exposure for sensitive integrations;
- OTP with one-time challenges, expiry, attempt limits and request cooldowns;
- customer-owned OTP start/verify integrations;
- versioned consent;
- identity-bound verification;
- generic HTTPS integrations with fixed origins, optional host allowlists, bounded timeouts and bounded responses;
- idempotency header propagation for side effects;
- SQS FIFO ordering and DLQ;
- DynamoDB PITR;
- event deduplication after successful processing;
- Secrets Manager;
- human handoff state;
- API Gateway access logs, detailed metrics and stage throttling;
- TypeScript configuration validation, unit tests, CDK synthesis and CI.

## Deployment profiles

### Shared SaaS

Use one stack with multiple tenant configurations.

Good fit when:

- customers accept logical tenant isolation;
- customer integrations are reachable from the runtime;
- common platform IAM and network controls are acceptable;
- operational simplicity and cost efficiency matter most.

### Dedicated regulated deployment

Deploy the same code into a dedicated AWS account/environment and seed only one customer's configuration.

Recommended when the customer requires:

- account-level isolation;
- customer-managed KMS keys;
- private networking;
- customer-owned logging/SIEM;
- restricted model/secret IAM;
- independent release windows;
- dedicated security controls.

The runtime code should stay identical between shared and dedicated deployments.

## Go-live acceptance checklist

Before routing real users:

1. Validate both tenant JSON and CDK synthesis in CI.
2. Confirm Meta webhook verification succeeds.
3. Confirm an invalid Meta signature is rejected.
4. Confirm the configured `phone_number_id` resolves to exactly one enabled tenant.
5. Send an inbound WhatsApp message and verify SQS -> Worker -> outbound delivery.
6. Verify the Web/API endpoint rejects invalid credentials, oversized messages and malformed JSON.
7. Execute every agent-exposed tool with valid and invalid input.
8. Execute every deterministic workflow end-to-end.
9. Verify OTP expiry, invalid attempts, one-time consumption and request cooldown.
10. Verify protected tools cannot run without required verification/consent.
11. Verify identity-bound tools reject a different subject.
12. Verify side-effecting APIs implement the configured idempotency key.
13. Force an upstream failure and confirm SQS retry + DLQ behavior.
14. Test human handoff and return-to-AI behavior.
15. Confirm no OTP, access token, Authorization header or unrestricted sensitive response is present in logs.
16. Confirm backup/PITR and data-retention expectations.
17. Load-test expected API and queue concurrency.
18. Complete customer security review and penetration testing.

## Synchronous API constraint

API Gateway HTTP APIs have a maximum integration timeout of 30 seconds. The synchronous `POST /v1/chat` path must therefore keep the complete turn below that boundary.

Slow processes should use one of these patterns:

- the queued WhatsApp path;
- an asynchronous API job;
- a durable workflow adapter such as Step Functions/Temporal when waits extend beyond a conversational session.

Do not increase Lambda timeout and assume the HTTP client can wait longer than API Gateway.

## Conversation concurrency

The WhatsApp path is serialized per tenant + user through the FIFO message group.

The synchronous Web/API path does not pass through SQS. Callers must serialize requests for the same `conversationId` in v1; simultaneous writes to the same conversation can otherwise race and the last persisted state can win. If a web/mobile client needs concurrent or bursty turns on the same conversation, route those turns through an asynchronous ordered path before production.

## WAF and edge controls

The default stack uses API Gateway HTTP API because it is simpler and lower cost.

AWS WAF directly supports API Gateway **REST API**, not HTTP API. If direct WAF association is a contractual requirement, use a dedicated edge profile such as:

- API Gateway REST API + WAF; or
- CloudFront + WAF in front of the service, after customer architecture review.

Do not silently replace the default edge for every tenant; keep this an explicit deployment profile.

## IAM and secrets

The shared generic runtime currently needs broad permissions for resources that are configured after deployment, especially tenant Secrets Manager ARNs and selectable Bedrock models.

For a dedicated regulated deployment:

- allow only approved Bedrock model/inference-profile ARNs;
- allow only the customer's secret ARN namespace;
- restrict SES identities and SNS usage;
- use customer-managed KMS keys when required;
- rotate customer tokens using the customer's approved mechanism;
- consider VPC endpoints/private connectivity for AWS and customer systems.

## Data and privacy

Decide per customer:

- conversation retention period;
- audit retention period;
- whether free-form conversation text may be stored;
- whether PII redaction is required before logs/model calls;
- whether data residency constrains AWS region/model selection;
- whether generated documents may use temporary public URLs or require media upload/private delivery.

Transactional workflow input is intentionally kept out of the normal LLM history, but this is not a substitute for a formal customer data-classification policy.

## Operational SLOs to define

At minimum define:

- webhook acceptance availability;
- queue age threshold;
- DLQ alarm threshold;
- Worker error-rate threshold;
- Bedrock latency/error threshold;
- upstream tool latency/error threshold;
- WhatsApp outbound failure threshold;
- OTP failure/lock/rate-limit threshold;
- monthly cost per tenant/conversation.

The repository documents what to measure; production customers should choose thresholds that match their SLA.

## Known product gaps

These are intentionally not hidden:

- no visual tenant/admin portal yet;
- no operator inbox UI yet;
- API-key authentication is the current Web/API control plane mechanism;
- no OIDC/SSO/RBAC UI yet;
- no built-in RAG/knowledge-base ingestion yet;
- no interactive WhatsApp list/button outbound rendering yet;
- no built-in immutable cross-account audit export yet;
- no generic PII-redaction layer yet;
- no dedicated REST/WAF deployment profile yet;
- no durable multi-day workflow engine yet.

None of these require changing the core execution model. They can be added as control-plane or adapter layers.

## Validation commands

```bash
npm install
npm run typecheck
npm test
npm run validate:tenant -- examples/tenant.example.json
npm run validate:tenant -- examples/financial-institution.reference.json
npm run synth -- -c stage=test -c defaultModelId=dummy-model -c apiRateLimit=100 -c apiBurstLimit=200
```

A green CI run is necessary but is not equivalent to customer production certification.

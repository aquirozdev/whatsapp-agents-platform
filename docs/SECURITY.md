# Security model

The platform is intentionally designed so that the LLM is **not** the authorization boundary.

## Trust boundaries

### Public edge

- API Gateway HTTP API has configurable stage throttling and access logs.
- Meta webhook verification uses a secret verify token.
- Meta webhook POST requests are validated with `X-Hub-Signature-256` and the Meta App Secret.
- REST requests require tenant ID + a high-entropy API key in v1.

### Tenant resolution

WhatsApp tenant selection comes from the Meta `phone_number_id`. The inbound user cannot choose an arbitrary tenant through prompt text.

### Agent vs workflow exposure

Tools can be marked:

```json
{ "exposure": "agent" }
```

```json
{ "exposure": "workflow" }
```

or `both`.

For sensitive financial, certificate, claims or transaction tools, prefer `workflow`. Workflow-only tools are never advertised to Bedrock in free agent mode.

This is a major security boundary: the model can route to a configured workflow, but it cannot freely call workflow-only transactional integrations.

## Deterministic authorization

A tool may declare:

```json
{
  "requiresVerification": "otp",
  "requiresConsents": [
    { "policyId": "personal-data", "version": "2026-01" }
  ]
}
```

The Tool Registry validates tool input against the configured JSON Schema and then checks verification/consent requirements before any upstream HTTP request is sent. Prompt injection cannot remove these checks.

Workflows also enforce sequence, but tool-level checks remain as defense in depth.

For identity-sensitive operations, configure `verificationSubjectFrom`. The policy engine compares that tool input to the subject bound during verification, preventing an OTP for one customer from being reused to query another customer.

## Consent

Consent is persisted independently from conversation history using:

```text
tenant + subject + policyId + policyVersion
```

A new policy version therefore requires a new acceptance.

Workflow consent steps record:

- acceptance time,
- channel,
- conversation,
- policy/version,
- subject.

By default the subject is the channel user ID. A workflow can use `subjectFrom` when a verified customer identifier should become the durable subject.

## OTP

### Built-in adapter

Built-in OTP provides:

- six-digit cryptographically generated code;
- HMAC-SHA256 digest at rest;
- HMAC key in Secrets Manager;
- short expiry;
- maximum attempts;
- an atomic per-user request cooldown (60 seconds by default);
- challenge binding to tenant + user + conversation;
- atomic one-time consumption;
- short-lived verified conversation state;
- audit events.

### Institution-owned OTP

Banks/cooperatives often own the OTP service. The deterministic workflow step can call:

```text
startTool -> registered-phone OTP service
verifyTool -> OTP verification service
```

The model never needs to see or choose the authoritative phone number.

This is the preferred pattern when the institution owns the registered customer contact data.

## Transactional workflow safety

The model chooses a workflow only through the platform-reserved `start_workflow` tool.

After a workflow starts:

- user input is handled by deterministic TypeScript;
- exact step ordering is enforced;
- confirmation can be required before side effects;
- OTP can be required before protected tools;
- sessions can expire;
- users can cancel;
- balances/fees can be rendered without model rewriting;
- documents can be delivered by the channel adapter.

For a paid certificate flow, place the generation/charge step after:

```text
quote -> confirmation -> verification
```

If the user rejects, cancels or times out before generation, the side-effecting tool is never reached.

## Idempotency

For side-effecting HTTP tools:

```json
{
  "http": {
    "idempotencyHeader": "Idempotency-Key"
  }
}
```

The platform forwards the inbound message ID in that header.

The upstream service must implement idempotency semantics if duplicate execution would be harmful.

The platform marks an inbound event as processed only **after** successful execution and outbound delivery, so SQS retries are not suppressed by premature deduplication.

## Secrets

Never place secrets in tenant JSON or Git:

- WhatsApp access tokens,
- Meta App Secret,
- banking/CRM/API credentials,
- OTP HMAC secret,
- private signing keys.

Reference Secrets Manager ARNs.

HTTP tools support `secretHeaders`:

```json
{
  "secretHeaders": {
    "Authorization": "arn:aws:secretsmanager:...:secret:bank-auth"
  }
}
```

Store the complete desired header value in the secret.

## Data handling

Conversation state stores the latest 30 free-form text messages plus workflow state.

Messages handled inside an active transactional workflow are not copied into Bedrock chat history. Workflow data is cleared on completion, cancellation or expiry by default.

Do not persist or log:

- plaintext OTP codes,
- passwords/PINs,
- card security codes,
- private tokens,
- unrestricted sensitive upstream payloads.

Workflow verification input is available as `{{input}}` for the verification call and is not automatically written to workflow data.

For regulated environments add PII redaction and a customer-approved retention policy.

## Documents

The current WhatsApp document delivery step uses a document URL.

That URL must be reachable by Meta when WhatsApp fetches it. For private generated PDFs, use a short-lived delivery URL or a media-upload strategy approved for the deployment.

Do not put credentials into document URLs.

## Audit

Audit events include:

- agent response/tool summary,
- workflow start/completion/cancellation/expiry,
- workflow tool failure,
- consent acceptance/rejection,
- OTP request/failure/success,
- workflow verification success,
- human handoff,
- manual conversation-mode changes.

For strict enterprise requirements, stream immutable audit copies to a dedicated logging account/bucket.

## Least privilege

The CDK stack currently grants broad resource scope where tenant resources are configured after deployment, notably:

- `bedrock:InvokeModel`,
- tenant Secrets Manager reads,
- SNS SMS,
- SES email.

For dedicated customer deployments, narrow these permissions to known models, secrets, SES identities and integration resources.

## Prompt-injection posture

Treat user messages, retrieved content and external API payloads as untrusted.

The model may:

- answer conversationally;
- request agent-exposed tools;
- request a configured workflow.

The model may not:

- create arbitrary tools,
- provide credentials,
- change tool exposure,
- bypass verification/consent checks,
- execute workflow-only tools directly,
- change workflow order.

## Enterprise hardening checklist

Before production use at a regulated institution, evaluate:

- dedicated AWS account/environment,
- WAF/approved edge controls,
- OIDC/Cognito for staff/admin APIs,
- customer-managed KMS keys,
- centralized immutable audit,
- GuardDuty/Security Hub/CloudTrail,
- VPC/private connectivity to internal systems,
- model allowlists,
- PII redaction and retention,
- outbound endpoint allowlists,
- per-tool rate limits,
- transaction confirmation rules,
- penetration testing and formal threat modeling.


## Outbound HTTP integration safety

Generic HTTP tools enforce the following runtime constraints:

- the URL origin cannot contain templates;
- HTTPS is required unless `allowInsecureHttp` is explicitly enabled;
- redirects are rejected;
- `allowedHosts` can enforce an exact hostname allowlist;
- upstream response size is bounded with `maxResponseBytes`;
- `responsePath` can expose only the required JSON subtree.

These controls reduce SSRF and accidental data-exposure risk without adding another service.

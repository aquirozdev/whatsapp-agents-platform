# Deterministic workflows

The platform supports two execution modes inside the same Worker Lambda:

1. **Agent mode** for normal conversational questions and safe/free-form tool use.
2. **Workflow mode** for transactional processes that must follow a deterministic sequence.

This keeps the platform generic: a bank balance flow, an insurance claim, an appointment booking and an order-status flow can all use the same runtime primitives.

## Why workflows exist

Prompts are not a reliable place to enforce:

- consent,
- identity collection,
- OTP,
- confirmation before a charge,
- ordered API calls,
- session expiry,
- exact financial rendering,
- document delivery.

The model may decide **which configured workflow matches the user's intent** by calling the reserved `start_workflow` tool. After that call, the LLM is removed from the transactional control path until the workflow completes, expires or is cancelled.

## Supported primitives

| Step | Purpose |
|---|---|
| `consent` | Check durable consent; prompt and persist acceptance if missing |
| `collect` | Collect and validate one user value |
| `verification` | Start and verify an OTP/KYC challenge through configured tools |
| `tool` | Call a configured integration deterministically |
| `select` | Let the user select from static or API-returned options |
| `confirm` | Require explicit yes/no confirmation |
| `branch` | Jump to a step based on workflow data |
| `render` | Render an exact deterministic message |
| `render_list` | Render bounded lists without asking an LLM to reproduce values |
| `deliver` | Deliver a document through the current channel |
| `end` | Complete the workflow |

The runtime intentionally does not implement BPMN, distributed sagas or arbitrary code expressions. Keep common business processes declarative; add a native tool when an integration requires complex domain logic.

## Workflow-only tools

Sensitive tools should usually not be visible to the free agent:

```json
{
  "name": "generate_certificate",
  "kind": "http",
  "exposure": "workflow",
  "requiresVerification": "otp"
}
```

`exposure` can be:

- `agent` — only Bedrock can request it in agent mode.
- `workflow` — only a deterministic workflow can execute it.
- `both` — available in both modes. This is the compatibility default.

For regulated use cases prefer `workflow` for account, payment, certificate, claim and other transactional integrations.

## Template data

Workflow data is addressed by dot paths.

A tool result saved as:

```json
{
  "saveAs": "identity"
}
```

can be referenced later:

```json
{
  "input": {
    "customerId": "{{identity.customerId}}"
  }
}
```

An exact placeholder preserves the original JSON type. Embedded placeholders become strings.

The current user response is available only to a verification step through `{{input}}`; it is not automatically persisted into workflow data.

## Consent

Example:

```json
{
  "id": "privacy",
  "type": "consent",
  "policyId": "personal-data",
  "version": "2026-01",
  "prompt": "Revise la política. ¿Acepta el tratamiento de datos?",
  "documentUrl": "https://example.com/privacy.pdf"
}
```

Acceptance is stored independently from conversation state using tenant + subject + policy + version. A policy version change therefore naturally requires new consent.

By default the subject is the channel user ID. `subjectFrom` can point to workflow data when a verified customer identifier should be the durable subject.

## Verification through any provider

The workflow engine does not know Twilio, Cognito or a specific bank.

It knows only two tools:

```json
{
  "id": "otp",
  "type": "verification",
  "startTool": "bank_send_otp",
  "startInput": {
    "customerId": "{{identity.customerId}}"
  },
  "verifyTool": "bank_verify_otp",
  "verifyInput": {
    "challengeId": "{{_verification.otp.challengeId}}",
    "code": "{{input}}"
  },
  "successPath": "verified",
  "prompt": "Ingrese el código enviado a su celular registrado."
}
```

This also works with the platform built-ins `request_verification` and `verify_code`.

When verification succeeds, the deterministic runtime grants a short-lived `otp` verification state. Protected tools still check that state independently.

## Selections

Static selection:

```json
{
  "type": "select",
  "field": "productType",
  "prompt": "Seleccione el tipo:",
  "store": "value",
  "options": [
    { "value": "savings", "label": "Ahorro" },
    { "value": "credit", "label": "Crédito" }
  ]
}
```

Dynamic selection:

```json
{
  "type": "select",
  "field": "account",
  "prompt": "Seleccione la cuenta:",
  "source": "accounts",
  "valuePath": "id",
  "labelPath": "displayName",
  "autoSelectSingle": true
}
```

A user can reply with the option number, exact value or exact label.

## Deterministic rendering

Do not ask the model to repeat balances, transaction amounts or certificate fees.

```json
{
  "type": "render",
  "template": "Saldo disponible: {{balance.available}} USD"
}
```

For arrays:

```json
{
  "type": "render_list",
  "source": "movements.items",
  "maxItems": 10,
  "header": "Últimos movimientos:",
  "itemTemplate": "{{index}}. {{item.date}} | {{item.amount}} | {{item.description}}"
}
```

## Confirmation before side effects

A charge-producing tool belongs **after** confirmation and verification:

```text
quote -> confirm -> verify -> generate/charge
```

If the user rejects or the workflow expires before the side-effecting step, that tool is never executed.

For side-effecting HTTP integrations configure `idempotencyHeader` so the platform sends the inbound message ID to the customer API as an idempotency key.

## Session expiry and cancellation

Each workflow can configure:

```json
{
  "sessionTtlSeconds": 600,
  "cancelWords": ["cancelar", "salir"],
  "cancelMessage": "Proceso cancelado.",
  "sessionExpiredMessage": "La sesión expiró. Inicie nuevamente."
}
```

State lives inside the normal conversation item; no additional AWS service is required.

## Branching

```json
{
  "id": "branch-type",
  "type": "branch",
  "path": "productType",
  "cases": {
    "savings": "load-savings",
    "credit": "load-credit"
  }
}
```

Targets reference step IDs, not array indexes, so workflows remain readable when steps are inserted.

## Limits by design

The workflow runtime is for conversational transactions lasting minutes, not multi-day business processes. Use a durable workflow engine only when the business process truly needs long waits, external callbacks, human approvals over hours/days or distributed compensation.


## Identity-bound verification

For regulated flows, do not treat an OTP as a blanket authorization for every identity reachable from the same chat session.

Bind the successful verification to an authoritative subject:

```json
{
  "id": "otp",
  "type": "verification",
  "subjectFrom": "customer.customerId",
  "startTool": "start_customer_otp",
  "verifyTool": "verify_customer_otp"
}
```

Then require the same subject on sensitive tools with `verificationSubjectFrom`.

## Filtered selections

Array-backed selections can be filtered without customer-specific code:

```json
{
  "type": "select",
  "field": "product",
  "source": "productResponse.products",
  "filter": {
    "path": "type",
    "equals": "{{productType}}"
  },
  "valuePath": "id",
  "labelPath": "displayName"
}
```

This is reusable for products, policies, vehicles, orders, appointments and other resource lists.

## Sensitive workflow data

Transactional inputs are intentionally not copied into the free-form Bedrock conversation history while a workflow is active.

Workflow data is cleared on completion, cancellation and expiry by default. Use `retainDataOnCompletion: true` only when there is a documented retention requirement.

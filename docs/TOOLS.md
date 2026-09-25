# Tools

Tools are the integration boundary between the generic platform and customer systems.

Amazon Bedrock can request agent-exposed tools, while deterministic workflows can call workflow-exposed tools. Application code always executes the tool.

## Tool binding

```ts
interface ToolBinding {
  name: string;
  kind: "builtin" | "http";
  description: string;
  inputSchema: JsonSchema;

  exposure?: "agent" | "workflow" | "both";

  requiresVerification?: "none" | "otp";
  verificationSubjectFrom?: string;

  requiresConsents?: Array<{
    policyId: string;
    version?: string;
    subjectFrom?: string;
  }>;

  http?: HttpToolConfig;
}
```

Tool names must be unique and match Bedrock's allowed tool-name format.

`start_workflow` is reserved by the platform.

## Exposure

### Agent-only

Use for safe conversational actions:

```json
{
  "name": "store_hours",
  "exposure": "agent"
}
```

### Workflow-only

Use for sensitive or sequence-dependent actions:

```json
{
  "name": "generate_certificate",
  "exposure": "workflow"
}
```

Workflow-only tools are not included in the tool list sent to Bedrock.

### Both

Use when either mode may call the same capability. `both` is the compatibility default when `exposure` is omitted.

## Built-in tools

### `request_verification`

Starts the platform's SNS/SES OTP adapter.

```json
{
  "channel": "sms",
  "destination": "+593..."
}
```

For regulated financial deployments, prefer resolving the registered destination on the institution side instead of letting free-form model input choose it.

### `verify_code`

```json
{
  "challengeId": "...",
  "code": "123456"
}
```

The challenge is tenant/user/conversation bound and one-time.

### `human_handoff`

```json
{
  "reason": "Customer requested an advisor"
}
```

Changes the conversation to human mode.

## HTTP tools

HTTP tools let tenants connect REST-style customer systems without adding Lambda functions.

```json
{
  "name": "policy_status",
  "kind": "http",
  "exposure": "workflow",
  "description": "Fetch insurance policy status.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "policyId": { "type": "string" }
    },
    "required": ["policyId"]
  },
  "http": {
    "method": "GET",
    "url": "https://insurance.example.com/policies/{{policyId}}",
    "headers": {
      "X-Source": "virtual-agent"
    },
    "secretHeaders": {
      "Authorization": "arn:aws:secretsmanager:...:secret:insurance-auth"
    },
    "timeoutMs": 5000
  }
}
```

URL placeholders are encoded. URL templates are allowed in path/query only, never in the origin. HTTPS is required by default, redirects are blocked, and `allowedHosts` can pin the exact upstream hostname.

Optional `maxResponseBytes` limits upstream payload size and `responsePath` can expose only a selected JSON subtree.

## Body templates

```json
{
  "bodyTemplate": {
    "customerId": "{{customer.customerId}}",
    "amount": "{{quote.amount}}"
  }
}
```

An exact placeholder preserves the JSON value type. Embedded placeholders render as strings.

## Secret headers

```json
{
  "secretHeaders": {
    "Authorization": "arn:aws:secretsmanager:..."
  }
}
```

The secret value becomes the full HTTP header value.

## Idempotency

Side-effecting integrations can receive the inbound message ID:

```json
{
  "idempotencyHeader": "Idempotency-Key"
}
```

The upstream API is responsible for honoring that key.

Use this for actions such as:

- certificate generation/charging,
- claim creation,
- ticket creation,
- payment initiation,
- appointment booking.

## Verification and consent protection

Example:

```json
{
  "name": "get_account_balance",
  "requiresVerification": "otp",
  "requiresConsents": [
    {
      "policyId": "personal-data",
      "version": "2026-01"
    }
  ]
}
```

The Tool Registry checks these requirements regardless of whether the caller is an agent or workflow.

## Workflow tools

A workflow can pass values collected earlier:

```json
{
  "id": "load-balance",
  "type": "tool",
  "tool": "get_account_balance",
  "input": {
    "accountId": "{{account.id}}"
  },
  "saveAs": "balance"
}
```

The result becomes available under `balance`.

See [WORKFLOWS.md](WORKFLOWS.md).

## When to write native TypeScript

Use a native tool instead of generic HTTP when the operation requires:

- cryptographic signing,
- special binary protocols,
- multi-call transaction coordination,
- strict response transformation/redaction,
- custom auth negotiation,
- local cryptography,
- domain-specific state transitions.

Keep the same `ToolExecutionResult` contract so the workflow/agent runtime remains unchanged.


## Identity-bound verification

For sensitive resources, pair verification with the customer identifier used by the upstream request:

```json
{
  "requiresVerification": "otp",
  "verificationSubjectFrom": "customerId"
}
```

The policy engine rejects the call when the active verified subject does not equal `input.customerId`, even if the OTP session has not expired.

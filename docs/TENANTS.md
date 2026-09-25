# Tenant configuration

A tenant represents one customer configuration, not an end-user and not a source-code fork.

## Minimal tenant

```json
{
  "tenantId": "customer-a",
  "displayName": "Customer A",
  "enabled": true,
  "systemPrompt": "...",
  "tools": []
}
```

## Model

```json
{
  "model": { "provider": "bedrock", "model": "region-appropriate-model-or-inference-profile" },
  "maxToolRounds": 6
}
```

If `model` is omitted, the deployment-level default model is used. Legacy `modelId` is interpreted as a Bedrock model during migration.

## WhatsApp

```json
{
  "whatsapp": {
    "phoneNumberId": "123456789",
    "accessTokenSecret": { "key": "whatsapp.access-token" },
    "graphApiVersion": "CURRENT_SUPPORTED_VERSION"
  }
}
```

Keep the Graph API version configurable per tenant. The repository examples currently pin `v26.0`; review Meta's version lifecycle during customer upgrades rather than hard-coding a platform-wide value. Do not hard-code customer tokens or secrets.

## Tools

Tools describe integrations and their security requirements.

Important tenant-level properties include:

- `exposure`,
- `requiresVerification`,
- `requiresConsents`,
- HTTP endpoint/template,
- logical secret references resolved by the deployment adapter,
- timeout,
- idempotency header.

See [TOOLS.md](TOOLS.md).

## Workflows

Transactional use cases are tenant configuration:

```json
{
  "workflows": [
    {
      "id": "account-balance",
      "name": "Consulta de saldo",
      "description": "Secure balance lookup",
      "triggerExamples": [
        "quiero ver mi saldo"
      ],
      "steps": []
    }
  ]
}
```

The model can route into a workflow, but cannot change its order.

See [WORKFLOWS.md](WORKFLOWS.md).

## Capabilities

Capabilities are product/control-plane metadata that group tools and workflows:

```json
{
  "capabilities": [
    {
      "id": "financial-self-service",
      "name": "Autoservicio financiero",
      "tools": [
        "list_products",
        "get_balance"
      ],
      "workflows": [
        "account-balance"
      ]
    }
  ]
}
```

The runtime does not branch on capability names. This metadata is intended for onboarding, configuration UIs and commercial packaging.

## REST API key

The seed CLI can derive the stored SHA-256 digest locally:

```bash
npm run seed:tenant -- tenant.json '<high-entropy-api-key>'
```

Do not put the plaintext key inside tenant JSON.

## Validation

Before publishing, the seed CLI validates the portable spec. Each successful publish creates an immutable config version (`CONFIG#vN`) and advances the active config atomically. Before writing to DynamoDB, it validates:

- required tenant fields and safe tenant ID format;
- maximum config/prompt sizes to stay below runtime storage limits,
- unique tool names,
- reserved tool names,
- HTTP URL/origin safety, HTTPS and host allowlists,
- workflow tool references,
- verification tool references,
- branch target step IDs,
- select-step source/options,
- capability tool/workflow references.

This catches configuration errors before deployment traffic reaches them.

## Customer-specific integration contracts

A reference tenant may show placeholder endpoints and field shapes when an RFC describes behavior but not the actual API contract.

Do not treat those placeholders as production assumptions. Replace them after obtaining the customer's service specification.

## Local admin

Run:

```bash
npm run admin
```

The server binds only to `127.0.0.1` and provides a deliberately small UI for:

- choosing a reusable template;
- editing tenant JSON;
- validating with the same `validateAgentConfig` rules;
- saving atomically to `tenants/*.json`;
- publishing the saved tenant to DynamoDB with local AWS credentials.

Mutating calls require an in-memory token injected into the locally served page. There is no hosted admin service, admin database or extra AWS resource.

Real customer files under `tenants/` are gitignored in this public repository. For a private customer deployment repository, teams may deliberately version approved/sanitized tenant JSON in Git if their governance permits it.

## Updating a tenant

Edit the JSON and seed/publish again. Publication preserves an existing Web/API key hash when no new plaintext key is supplied, and refuses to bind a WhatsApp `phoneNumberId` already owned by another tenant.

Use Git for review/history instead of building a second configuration database. If a customer later requires formal four-eyes approval, release promotion or an enterprise operator portal, add that as an optional control-plane profile rather than changing the runtime.

## Offline validation

Validate a tenant without connecting to DynamoDB:

```bash
npm run validate:tenant -- examples/financial-institution.reference.json
```

Use this in onboarding pipelines before configuration is promoted to an environment.

## Configuration schema lifecycle

New tenant JSON should include `"schemaVersion": 1`. The runtime currently migrates legacy schema-0 configuration at ingestion/read boundaries for backwards compatibility; publishers write the current schema. Use `npm run migrate:tenant -- tenant.json --write` before committing old files and `npm run diff:tenant -- old.json new.json` during review.

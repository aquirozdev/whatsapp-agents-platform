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
  "modelId": "region-appropriate-bedrock-model-or-inference-profile",
  "maxToolRounds": 6
}
```

If `modelId` is empty, the stack-level `defaultModelId` is used.

## WhatsApp

```json
{
  "whatsapp": {
    "phoneNumberId": "123456789",
    "accessTokenSecretArn": "arn:aws:secretsmanager:...",
    "graphApiVersion": "CURRENT_SUPPORTED_VERSION"
  }
}
```

Keep the Graph API version configurable per tenant. Do not hard-code customer tokens or secrets.

## Tools

Tools describe integrations and their security requirements.

Important tenant-level properties include:

- `exposure`,
- `requiresVerification`,
- `requiresConsents`,
- HTTP endpoint/template,
- Secrets Manager header references,
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

Before writing to DynamoDB, the seed CLI validates:

- required tenant fields,
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

## Updating a tenant

Edit the JSON and seed again. The tenant config item is replaced atomically.

Before adding a production admin UI, add:

- config versioning,
- schema version,
- draft/publish states,
- approval workflow,
- rollback.


## Offline validation

Validate a tenant without connecting to DynamoDB:

```bash
npm run validate:tenant -- examples/financial-institution.reference.json
```

Use this in onboarding pipelines before configuration is promoted to an environment.

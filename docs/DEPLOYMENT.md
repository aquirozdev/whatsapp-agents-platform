# Deployment

## 1. AWS prerequisites

Use an AWS account/region with:

- CDK bootstrap completed;
- access to the required Amazon Bedrock model or inference profile;
- SES verified identity if email OTP is enabled;
- SNS SMS permissions and regional SMS configuration if SMS OTP is enabled.

Recommended first deployment: a non-production account.

## 2. Install and validate

```bash
npm install
npm run typecheck
npm test
npm run synth -- -c stage=dev -c defaultModelProvider=bedrock -c defaultModelId='YOUR_MODEL_ID'
```

## 3. Deploy

```bash
npm run deploy -- \
  -c stage=dev \
  -c defaultModelId='YOUR_MODEL_ID' \
  -c apiRateLimit=100 \
  -c apiBurstLimit=200 \
  -c otpEmailFrom='no-reply@example.com'
```

`stage` affects resource naming. Deploying `dev`, `staging` and `prod` produces independent stacks.

## 4. Replace the Meta App Secret

The stack creates a random placeholder to avoid putting the real Meta secret in CloudFormation or source control.

After deployment:

```bash
aws secretsmanager put-secret-value \
  --secret-id '<MetaAppSecretArn>' \
  --secret-string '<REAL_META_APP_SECRET>'
```

## 5. Get the WhatsApp webhook verify token

```bash
aws secretsmanager get-secret-value \
  --secret-id '<WhatsAppVerifyTokenSecretArn>' \
  --query SecretString \
  --output text
```

In Meta Developer Console configure:

```text
Callback URL = <ApiUrl>/webhooks/whatsapp
Verify token = the secret value above
```

Subscribe to the WhatsApp `messages` webhook field.

## 6. Create tenant WhatsApp token secret

Store the long-lived/system-user access token separately per tenant:

```bash
aws secretsmanager create-secret \
  --name 'whatsapp-agents/prod/cooperativa-demo/whatsapp-token' \
  --secret-string '<META_ACCESS_TOKEN>'
```

Use the returned secret identifier as the AWS binding for the logical tenant reference `whatsapp.accessTokenSecret.key`. New tenant specs should use a logical key (for example `tenant/customer/whatsapp-token`); legacy `accessTokenSecretArn` remains accepted while migrating existing tenants.

## 7. Seed the tenant

Copy the example:

```bash
cp examples/tenant.example.json tenant.cooperativa-demo.json
```

Replace placeholders. Then:

```bash
TABLE_NAME='<TableName>' \
AWS_REGION='<region>' \
npm run seed:tenant -- tenant.cooperativa-demo.json '<HIGH_ENTROPY_API_KEY>'
```

Prefer tenant `model: { provider, model }`. If no tenant model is configured, the worker uses stack-level `defaultModelProvider` + `defaultModelId`. Legacy `modelId` remains accepted as Bedrock during migration.

## 8. Validate

Health:

```bash
curl '<ApiUrl>/health'
```

Web API:

```bash
curl -X POST '<ApiUrl>/v1/chat' \
  -H 'content-type: application/json' \
  -H 'x-tenant-id: cooperativa-demo' \
  -H 'x-api-key: <HIGH_ENTROPY_API_KEY>' \
  -d '{"userId":"smoke-test","message":"Hola"}'
```

Then send a WhatsApp message to the configured WABA number and inspect CloudWatch logs if it does not reply.

## Dedicated customer deployment

A regulated customer can receive the exact same stack in its AWS account:

```bash
AWS_PROFILE=customer-prod npm run deploy -- \
  -c stage=prod \
  -c defaultModelId='...'
```

No customer-specific Lambda fork is required.

## Removal

The DynamoDB table has `RemovalPolicy.RETAIN`, so deleting the stack intentionally does not delete customer state. Remove retained data only through an explicit data-retention procedure.


## HTTP API edge profile

The default deployment intentionally uses API Gateway **HTTP API** for lower cost and a small operational footprint. The stage enables access logging, detailed metrics and configurable throttling.

AWS documents a maximum HTTP API integration timeout of 30 seconds. Keep synchronous `POST /v1/chat` turns comfortably below that limit; use the queued WhatsApp path or an asynchronous integration pattern for slower jobs.

AWS WAF integrates directly with API Gateway REST APIs, not HTTP APIs. If a regulated customer requires direct WAF association or REST usage plans/API-key quotas, use a dedicated edge profile (REST API or CloudFront/WAF in front of the service) rather than complicating the shared default stack.

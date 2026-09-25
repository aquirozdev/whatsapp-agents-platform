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
npm run synth -- -c stage=dev -c defaultModelId='YOUR_MODEL_ID'
```

## 3. Deploy

```bash
npm run deploy -- \
  -c stage=dev \
  -c defaultModelId='YOUR_MODEL_ID' \
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

Put the returned ARN in `whatsapp.accessTokenSecretArn`.

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

If `modelId` is empty, the worker uses the stack `defaultModelId`.

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

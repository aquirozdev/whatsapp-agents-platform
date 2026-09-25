# Operations

## Logs

Both Lambdas emit CloudWatch logs. API Gateway also writes access logs and enables detailed stage metrics. Application logs use one-line JSON where practical.

Key dimensions to include when debugging:

- tenant ID
- external message ID
- SQS record/message ID
- WhatsApp phone number ID
- user/conversation ID
- tool call names

Do not log access tokens, OTP codes, Authorization headers or full sensitive upstream payloads.

## Edge throttling

The default HTTP API stage target is 100 requests/second with a burst of 200. Override at deploy time with CDK context:

```bash
-c apiRateLimit=200 -c apiBurstLimit=400
```

API Gateway HTTP API throttling is best-effort protection, not a tenant quota. Add tenant-aware limits in the application or use a different API profile when contractual per-client quotas are required.

## Dead-letter queue

After five failed receives, SQS sends a message to the FIFO DLQ.

Operational procedure:

1. inspect worker logs for the message ID;
2. identify whether the cause is permanent (bad config) or transient (upstream outage);
3. fix the dependency/configuration;
4. redrive the DLQ through AWS tooling;
5. confirm Dynamo event dedupe behavior before manually replaying old payloads.

## Common failures

### Webhook verifies but inbound messages do not arrive

Check Meta webhook subscriptions and that the `messages` field is subscribed.

### HTTP 401 on Meta webhook POST

The Meta App Secret in Secrets Manager does not match the app that signed the event, or the request body was modified before signature validation.

### Unknown/disabled phone number warning

No enabled tenant is indexed for the inbound `phone_number_id`. Re-seed the tenant and confirm the ID from the webhook payload.

### Bedrock access denied

Confirm model access, model/inference-profile ID, region and IAM permission.

### WhatsApp outbound 401/403

Check the tenant token secret and WABA/phone permissions. Long-lived production tokens should be system-user tokens with the minimum required permissions.

### Email OTP not sent

Verify SES sender identity and whether the account is still in SES sandbox.

### SMS OTP not sent

Check SNS SMS spend limit, destination support and regional SMS configuration.

### OTP_RATE_LIMITED

Built-in OTP requests are atomically rate-limited per tenant + channel user. The default cooldown is 60 seconds and can be changed with `otp.requestCooldownSeconds`.

## Metrics to add before large production traffic

- ingress accepted/rejected webhook count;
- SQS age of oldest message;
- DLQ depth;
- worker error rate;
- Bedrock latency and errors;
- tool latency/error rate by tool name;
- WhatsApp send error rate;
- OTP failure/lock rate;
- handoff count;
- cost per tenant/conversation.

## Backups

DynamoDB Point-in-Time Recovery is enabled. The table is retained on stack deletion.

Secrets Manager rotation is not automated in v1 because WhatsApp and customer-system token rotation methods vary by tenant.

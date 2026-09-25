# Testing strategy

The project keeps testing layered so portability does not require a large local platform.

## Unit tests

`npm test` runs deterministic unit tests and architecture-boundary checks without cloud credentials.

## Architecture tests

`tests/architecture-boundaries.test.ts` prevents cloud SDK imports from crossing into the portable runtime. This turns the provider-neutral design rule into an executable constraint.

## Floci integration tests

Floci is used as an AWS-shaped local emulator for DynamoDB, SQS and Secrets Manager adapters.

Run:

```bash
docker compose -f docker-compose.floci.yml up -d
npm run test:integration
docker compose -f docker-compose.floci.yml down
```

The integration suite verifies:

- immutable tenant configuration versions;
- optimistic conversation revisions;
- atomic conversation + processed-event commits;
- durable outbound replay state;
- conversation leases;
- logical secret resolution;
- FIFO dispatcher behavior.

The suite intentionally does not emulate model quality. Model adapters are tested through contract tests and provider-specific staging tests.

## What remains external

Meta webhook/send behavior and real model-provider behavior should be covered by staging smoke tests because local emulators cannot provide authoritative compatibility for those external APIs.

## Contract suites

`npm run test:contracts` exercises provider/channel/resilience contracts independently of customer configuration. New adapters should be added to the appropriate contract suite in addition to provider-specific tests. The Floci suite is the storage/dispatcher/secrets contract proof for the AWS adapter and also covers delivery reconciliation and distributed tool quotas.

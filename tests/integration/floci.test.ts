import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from "@aws-sdk/client-dynamodb";
import { CreateQueueCommand, DeleteQueueCommand, ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { CreateSecretCommand, DeleteSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { PlatformStore } from "../../src/storage/dynamo.js";
import { AwsSecretsManagerProvider } from "../../src/adapters/aws/secrets-manager.js";
import { AwsSqsTurnDispatcher } from "../../src/adapters/aws/sqs-dispatcher.js";
import { awsClientOptions } from "../../src/adapters/aws/client-options.js";
import { ConversationConflictError } from "../../src/ports/store.js";
import type { AgentConfig, InboundEnvelope } from "../../src/core/types.js";

const enabled = Boolean(process.env.FLOCI_ENDPOINT_URL || process.env.AWS_ENDPOINT_URL);
const suffix = Date.now().toString(36);
const tableName = `wap-test-${suffix}`;
const queueName = `wap-test-${suffix}.fifo`;
const secretName = `wap/test/${suffix}`;

describe.skipIf(!enabled)("Floci AWS adapter integration", () => {
  const dynamo = new DynamoDBClient(awsClientOptions());
  const sqs = new SQSClient(awsClientOptions());
  const secretsClient = new SecretsManagerClient(awsClientOptions());
  let queueUrl = "";

  beforeAll(async () => {
    await dynamo.send(new CreateTableCommand({
      TableName: tableName,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "gsi1pk", AttributeType: "S" },
        { AttributeName: "gsi1sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [{
        IndexName: "gsi1",
        KeySchema: [
          { AttributeName: "gsi1pk", KeyType: "HASH" },
          { AttributeName: "gsi1sk", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      }],
    }));
    await waitUntilTableExists({ client: dynamo, maxWaitTime: 30 }, { TableName: tableName });

    const queue = await sqs.send(new CreateQueueCommand({
      QueueName: queueName,
      Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" },
    }));
    queueUrl = queue.QueueUrl!;
    await secretsClient.send(new CreateSecretCommand({ Name: secretName, SecretString: "secret-value" }));
  }, 20000);

  afterAll(async () => {
    if (queueUrl) await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => undefined);
    await dynamo.send(new DeleteTableCommand({ TableName: tableName })).catch(() => undefined);
    await secretsClient.send(new DeleteSecretCommand({ SecretId: secretName, ForceDeleteWithoutRecovery: true })).catch(() => undefined);
  });

  it("versions tenant configuration immutably", async () => {
    const store = new PlatformStore(tableName);
    const tenant: AgentConfig = {
      tenantId: "tenant-a",
      displayName: "Tenant A",
      enabled: true,
      systemPrompt: "hello",
      tools: [],
    };
    expect(await store.putTenant(tenant)).toBe(1);
    expect(await store.putTenant({ ...tenant, systemPrompt: "hello v2" })).toBe(2);
    expect((await store.getTenant("tenant-a"))?.configVersion).toBe(2);
    expect((await store.getTenantVersion("tenant-a", 1))?.systemPrompt).toBe("hello");
    expect((await store.getTenantVersion("tenant-a", 2))?.systemPrompt).toBe("hello v2");
  });

  it("enforces optimistic conversation revisions and leases", async () => {
    const store = new PlatformStore(tableName);
    const state = await store.getConversation("tenant-a", "web", "c1", "u1");
    const stale = structuredClone(state);

    await store.saveConversation(state, 0);
    expect(state.revision).toBe(1);
    await expect(store.saveConversation(stale, 0)).rejects.toBeInstanceOf(ConversationConflictError);

    expect(await store.acquireConversationLease("tenant-a", "web", "c1", "owner-1", 30)).toBe(true);
    expect(await store.acquireConversationLease("tenant-a", "web", "c1", "owner-2", 30)).toBe(false);
    await store.releaseConversationLease("tenant-a", "web", "c1", "owner-1");
    expect(await store.acquireConversationLease("tenant-a", "web", "c1", "owner-2", 30)).toBe(true);
  });

  it("commits conversation state and durable outbound atomically", async () => {
    const store = new PlatformStore(tableName);
    const state = await store.getConversation("tenant-a", "whatsapp", "c-outbox", "u-outbox");
    await store.commitTurn(state, 0, {
      externalMessageId: "wamid.atomic",
      tenantId: "tenant-a",
      channel: "whatsapp",
      configVersion: 2,
      outbound: [{ kind: "text", text: "respuesta durable" }],
      processedAt: new Date().toISOString(),
    });

    expect(state.revision).toBe(1);
    const event = await store.getProcessedEvent("wamid.atomic");
    expect(event?.outbound).toEqual([{ kind: "text", text: "respuesta durable" }]);
    expect(event?.deliveredAt).toBeUndefined();

    await store.markEventDelivered("wamid.atomic", "2026-01-01T00:00:00.000Z");
    expect((await store.getProcessedEvent("wamid.atomic"))?.deliveredAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("persists delivery receipts, reconciles statuses, and enforces tool quotas", async () => {
    const store = new PlatformStore(tableName);
    const state = await store.getConversation("tenant-a", "whatsapp", "c-delivery", "u-delivery");
    await store.commitTurn(state, 0, {
      externalMessageId: "wamid.delivery",
      tenantId: "tenant-a",
      channel: "whatsapp",
      outbound: [{ kind: "text", text: "hello" }],
      processedAt: new Date().toISOString(),
    });
    await store.recordOutboundReceipt("wamid.delivery", {
      providerMessageId: "wamid.provider",
      acceptedAt: "2026-01-01T00:00:00.000Z",
      status: "accepted",
    });
    expect((await store.getProcessedEvent("wamid.delivery"))?.acceptedOutboundCount).toBe(1);

    await store.updateOutboundStatus({
      providerMessageId: "wamid.provider",
      status: "delivered",
      occurredAt: "2026-01-01T00:01:00.000Z",
    });
    const delivered = await store.getProcessedEvent("wamid.delivery");
    expect(delivered?.deliveryStatus?.status).toBe("delivered");
    expect(delivered?.deliveredAt).toBe("2026-01-01T00:01:00.000Z");

    expect(await store.claimToolRateSlot("tenant-a", "lookup", "u1", 60, 1)).toBe(true);
    expect(await store.claimToolRateSlot("tenant-a", "lookup", "u1", 60, 1)).toBe(false);
  });

  it("resolves secrets and dispatches FIFO turns through AWS-shaped adapters", async () => {
    const secretProvider = new AwsSecretsManagerProvider();
    expect(await secretProvider.get({ key: secretName })).toBe("secret-value");

    const dispatcher = new AwsSqsTurnDispatcher(queueUrl);
    const inbound: InboundEnvelope = {
      tenantId: "tenant-a",
      channel: "whatsapp",
      conversationId: "u1",
      userId: "u1",
      text: "hola",
      externalMessageId: `wamid.${suffix}`,
      receivedAt: new Date().toISOString(),
    };
    await dispatcher.dispatch(inbound, { orderingKey: "tenant-a:u1", dedupeKey: inbound.externalMessageId });
    const received = await sqs.send(new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 1, WaitTimeSeconds: 1 }));
    expect(received.Messages?.[0]?.Body).toContain(inbound.externalMessageId);
  });
});

import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { AgentConfig, ConsentRecord, ConversationState, OtpChallenge, ProcessedEventRecord } from "../core/types.js";
import type { PlatformStorePort } from "../ports/store.js";
import { ConversationConflictError } from "../ports/store.js";
import { awsClientOptions } from "../adapters/aws/client-options.js";

const defaultTableName = process.env.TABLE_NAME ?? "WhatsappAgentsPlatform";
const defaultClient = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientOptions()), {
  marshallOptions: { removeUndefinedValues: true },
});

function conversationPk(tenantId: string, channel: string, conversationId: string): string {
  return `TENANT#${tenantId}#CONV#${channel}#${conversationId}`;
}

export class PlatformStore implements PlatformStorePort {
  constructor(
    private readonly tableName = defaultTableName,
    private readonly client = defaultClient,
  ) {}

  async getTenant(tenantId: string): Promise<AgentConfig | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `TENANT#${tenantId}`, sk: "CONFIG" },
    }));
    return result.Item?.config as AgentConfig | undefined;
  }

  async getTenantVersion(tenantId: string, version: number): Promise<AgentConfig | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `TENANT#${tenantId}`, sk: `CONFIG#v${version}` },
    }));
    return result.Item?.config as AgentConfig | undefined;
  }

  async getTenantByWhatsAppPhoneNumberId(phoneNumberId: string): Promise<AgentConfig | undefined> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.tableName,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": `WA_PHONE#${phoneNumberId}` },
      Limit: 1,
    }));
    return result.Items?.[0]?.config as AgentConfig | undefined;
  }

  async putTenant(config: AgentConfig): Promise<number> {
    const existing = await this.getTenant(config.tenantId);
    const expectedVersion = existing?.configVersion ?? 0;
    const version = expectedVersion + 1;
    const versioned: AgentConfig = { ...config, configVersion: version };

    const activeItem = {
      pk: `TENANT#${config.tenantId}`,
      sk: "CONFIG",
      gsi1pk: versioned.whatsapp ? `WA_PHONE#${versioned.whatsapp.phoneNumberId}` : undefined,
      gsi1sk: versioned.whatsapp ? `TENANT#${versioned.tenantId}` : undefined,
      entity: "tenant",
      config: versioned,
      configVersion: version,
      updatedAt: new Date().toISOString(),
    };

    const condition = existing
      ? expectedVersion === 0
        ? "attribute_not_exists(#config.#version) OR #config.#version = :expected"
        : "#config.#version = :expected"
      : "attribute_not_exists(pk)";

    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: activeItem,
              ConditionExpression: condition,
              ExpressionAttributeNames: existing ? { "#config": "config", "#version": "configVersion" } : undefined,
              ExpressionAttributeValues: existing ? { ":expected": expectedVersion } : undefined,
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                pk: `TENANT#${config.tenantId}`,
                sk: `CONFIG#v${version}`,
                entity: "tenant_config_version",
                config: versioned,
                configVersion: version,
                createdAt: new Date().toISOString(),
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }));
      return version;
    } catch (error) {
      if (error instanceof Error && ["TransactionCanceledException", "ConditionalCheckFailedException"].includes(error.name)) {
        throw new Error(`Tenant ${config.tenantId} configuration changed concurrently; reload before publishing.`);
      }
      throw error;
    }
  }

  async getConversation(tenantId: string, channel: string, conversationId: string, userId: string): Promise<ConversationState> {
    const pk = conversationPk(tenantId, channel, conversationId);
    const result = await this.client.send(new GetCommand({ TableName: this.tableName, Key: { pk, sk: "STATE" } }));
    if (result.Item?.state) {
      const state = result.Item.state as ConversationState;
      state.revision = Number(result.Item.revision ?? state.revision ?? 0);
      return state;
    }
    return {
      tenantId,
      channel: channel as ConversationState["channel"],
      conversationId,
      userId,
      mode: "ai",
      messages: [],
      verification: { level: "none" },
      revision: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  async saveConversation(state: ConversationState, expectedRevision = state.revision ?? 0): Promise<void> {
    const nextRevision = expectedRevision + 1;
    state.updatedAt = new Date().toISOString();
    state.messages = state.messages.slice(-30);
    state.revision = nextRevision;

    const condition = expectedRevision === 0
      ? "attribute_not_exists(pk) OR attribute_not_exists(revision) OR revision = :expected"
      : "revision = :expected";

    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: conversationPk(state.tenantId, state.channel, state.conversationId),
          sk: "STATE",
          entity: "conversation",
          revision: nextRevision,
          state,
          updatedAt: state.updatedAt,
        },
        ConditionExpression: condition,
        ExpressionAttributeValues: { ":expected": expectedRevision },
      }));
    } catch (error) {
      state.revision = expectedRevision;
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") throw new ConversationConflictError();
      throw error;
    }
  }

  async commitTurn(state: ConversationState, expectedRevision: number, event: ProcessedEventRecord): Promise<void> {
    const nextRevision = expectedRevision + 1;
    state.updatedAt = new Date().toISOString();
    state.messages = state.messages.slice(-30);
    state.revision = nextRevision;

    const conversationCondition = expectedRevision === 0
      ? "attribute_not_exists(pk) OR attribute_not_exists(revision) OR revision = :expected"
      : "revision = :expected";

    const now = Math.floor(Date.now() / 1000);
    const eventTtl = event.expiresAt ?? now + 86400;

    try {
      await this.client.send(new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.tableName,
              Item: {
                pk: conversationPk(state.tenantId, state.channel, state.conversationId),
                sk: "STATE",
                entity: "conversation",
                revision: nextRevision,
                state,
                updatedAt: state.updatedAt,
              },
              ConditionExpression: conversationCondition,
              ExpressionAttributeValues: { ":expected": expectedRevision },
            },
          },
          {
            Put: {
              TableName: this.tableName,
              Item: {
                pk: `EVENT#${event.externalMessageId}`,
                sk: "EVENT",
                entity: "processed_event",
                event: { ...event, expiresAt: eventTtl },
                processedAt: event.processedAt,
                ttl: eventTtl,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }));
    } catch (error) {
      state.revision = expectedRevision;
      if (error instanceof Error && ["TransactionCanceledException", "ConditionalCheckFailedException"].includes(error.name)) {
        throw new ConversationConflictError();
      }
      throw error;
    }
  }

  async setConversationMode(tenantId: string, channel: string, conversationId: string, mode: "ai" | "human"): Promise<void> {
    await this.client.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { pk: conversationPk(tenantId, channel, conversationId), sk: "STATE" },
      UpdateExpression: "SET #state.#mode = :mode, #state.updatedAt = :updatedAt, #revision = if_not_exists(#revision, :zero) + :one, #state.#stateRevision = if_not_exists(#state.#stateRevision, :zero) + :one",
      ExpressionAttributeNames: {
        "#state": "state",
        "#mode": "mode",
        "#revision": "revision",
        "#stateRevision": "revision",
      },
      ExpressionAttributeValues: { ":mode": mode, ":updatedAt": new Date().toISOString(), ":zero": 0, ":one": 1 },
    }));
  }

  async acquireConversationLease(
    tenantId: string,
    channel: string,
    conversationId: string,
    owner: string,
    leaseSeconds = 120,
  ): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + leaseSeconds;
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: conversationPk(tenantId, channel, conversationId),
          sk: "LEASE",
          entity: "conversation_lease",
          owner,
          expiresAt,
          ttl: expiresAt + 3600,
        },
        ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :now",
        ExpressionAttributeValues: { ":now": now },
      }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async releaseConversationLease(tenantId: string, channel: string, conversationId: string, owner: string): Promise<void> {
    try {
      await this.client.send(new DeleteCommand({
        TableName: this.tableName,
        Key: { pk: conversationPk(tenantId, channel, conversationId), sk: "LEASE" },
        ConditionExpression: "#owner = :owner",
        ExpressionAttributeNames: { "#owner": "owner" },
        ExpressionAttributeValues: { ":owner": owner },
      }));
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return;
      throw error;
    }
  }

  async getProcessedEvent(externalMessageId: string): Promise<ProcessedEventRecord | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `EVENT#${externalMessageId}`, sk: "EVENT" },
    }));
    if (result.Item?.event) return result.Item.event as ProcessedEventRecord;
    if (result.Item) {
      return {
        externalMessageId,
        tenantId: "",
        channel: "web",
        outbound: [],
        processedAt: String(result.Item.processedAt ?? ""),
      };
    }
    return undefined;
  }

  async isEventProcessed(externalMessageId: string): Promise<boolean> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `EVENT#${externalMessageId}`, sk: "EVENT" },
      ProjectionExpression: "pk",
    }));
    return Boolean(result.Item);
  }

  async markEventProcessed(externalMessageId: string, ttlSeconds = 86400): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `EVENT#${externalMessageId}`,
        sk: "EVENT",
        entity: "event_dedupe",
        processedAt: new Date().toISOString(),
        ttl: now + ttlSeconds,
      },
    }));
  }

  async markEventDelivered(externalMessageId: string, deliveredAt = new Date().toISOString()): Promise<void> {
    await this.client.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { pk: `EVENT#${externalMessageId}`, sk: "EVENT" },
      UpdateExpression: "SET event.deliveredAt = :deliveredAt",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeValues: { ":deliveredAt": deliveredAt },
    }));
  }

  async claimOtpRequestSlot(tenantId: string, userId: string, cooldownSeconds: number): Promise<boolean> {
    if (cooldownSeconds <= 0) return true;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + cooldownSeconds;
    try {
      await this.client.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `TENANT#${tenantId}#OTP_RATE#${userId}`,
          sk: "SLOT",
          entity: "otp_rate_limit",
          expiresAt,
          ttl: expiresAt + 3600,
        },
        ConditionExpression: "attribute_not_exists(pk) OR expiresAt <= :now",
        ExpressionAttributeValues: { ":now": now },
      }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async putOtpChallenge(challenge: OtpChallenge): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `TENANT#${challenge.tenantId}#OTP#${challenge.challengeId}`,
        sk: "CHALLENGE",
        entity: "otp",
        challenge,
        ttl: challenge.expiresAt + 3600,
      },
    }));
  }

  async getOtpChallenge(tenantId: string, challengeId: string): Promise<OtpChallenge | undefined> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `TENANT#${tenantId}#OTP#${challengeId}`, sk: "CHALLENGE" },
    }));
    return result.Item?.challenge as OtpChallenge | undefined;
  }

  async consumeOtpChallenge(tenantId: string, challengeId: string, consumedAt: string): Promise<boolean> {
    try {
      await this.client.send(new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: `TENANT#${tenantId}#OTP#${challengeId}`, sk: "CHALLENGE" },
        UpdateExpression: "SET challenge.consumedAt = :consumedAt",
        ConditionExpression: "attribute_not_exists(challenge.consumedAt)",
        ExpressionAttributeValues: { ":consumedAt": consumedAt },
      }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  async incrementOtpAttempt(tenantId: string, challengeId: string): Promise<void> {
    await this.client.send(new UpdateCommand({
      TableName: this.tableName,
      Key: { pk: `TENANT#${tenantId}#OTP#${challengeId}`, sk: "CHALLENGE" },
      UpdateExpression: "SET challenge.attempts = challenge.attempts + :one",
      ExpressionAttributeValues: { ":one": 1 },
    }));
  }

  async hasConsent(tenantId: string, subjectId: string, policyId: string, version = "1"): Promise<boolean> {
    const result = await this.client.send(new GetCommand({
      TableName: this.tableName,
      Key: { pk: `TENANT#${tenantId}#SUBJECT#${subjectId}`, sk: `CONSENT#${policyId}#${version}` },
      ProjectionExpression: "pk",
    }));
    return Boolean(result.Item);
  }

  async recordConsent(record: ConsentRecord): Promise<void> {
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `TENANT#${record.tenantId}#SUBJECT#${record.subjectId}`,
        sk: `CONSENT#${record.policyId}#${record.version}`,
        entity: "consent",
        consent: record,
        acceptedAt: record.acceptedAt,
      },
    }));
  }

  async audit(tenantId: string, action: string, data: Record<string, unknown>): Promise<void> {
    const timestamp = new Date().toISOString();
    const date = timestamp.slice(0, 10);
    await this.client.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `TENANT#${tenantId}#AUDIT#${date}`,
        sk: `${timestamp}#${randomUUID()}`,
        entity: "audit",
        action,
        data,
        timestamp,
      },
    }));
  }
}

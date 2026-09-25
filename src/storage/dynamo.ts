import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { AgentConfig, ConsentRecord, ConversationState, EventRecord, OtpChallenge, OutboundMessage } from "../core/types.js";
import type { PlatformStorePort } from "../ports/store.js";

const tableName = process.env.TABLE_NAME ?? "WhatsappAgentsPlatform";
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export class ConversationConflictError extends Error {
  constructor() {
    super("Conversation changed concurrently. Retry the turn.");
    this.name = "ConversationConflictError";
  }
}

export class PlatformStore implements PlatformStorePort {
  async getTenant(tenantId: string): Promise<AgentConfig | undefined> {
    const result = await client.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `TENANT#${tenantId}`, sk: "CONFIG" },
    }));
    return result.Item?.config as AgentConfig | undefined;
  }

  async getTenantVersion(tenantId: string, version: string): Promise<AgentConfig | undefined> {
    const result = await client.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `TENANT#${tenantId}`, sk: `CONFIG#${version}` },
    }));
    return result.Item?.config as AgentConfig | undefined;
  }

  async getTenantByWhatsAppPhoneNumberId(phoneNumberId: string): Promise<AgentConfig | undefined> {
    const result = await client.send(new QueryCommand({
      TableName: tableName,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": `WA_PHONE#${phoneNumberId}` },
      Limit: 1,
    }));
    return result.Items?.[0]?.config as AgentConfig | undefined;
  }

  async putTenant(config: AgentConfig): Promise<void> {
    const version = config.configVersion ?? `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const published: AgentConfig = { ...config, configVersion: version };
    const now = new Date().toISOString();

    await client.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: `TENANT#${config.tenantId}`,
              sk: `CONFIG#${version}`,
              entity: "tenant_config_version",
              config: published,
              version,
              createdAt: now,
            },
            ConditionExpression: "attribute_not_exists(pk)",
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: {
              pk: `TENANT#${config.tenantId}`,
              sk: "CONFIG",
              gsi1pk: published.whatsapp ? `WA_PHONE#${published.whatsapp.phoneNumberId}` : undefined,
              gsi1sk: published.whatsapp ? `TENANT#${published.tenantId}` : undefined,
              entity: "tenant",
              config: published,
              activeVersion: version,
              updatedAt: now,
            },
          },
        },
      ],
    }));
  }

  async getConversation(
    tenantId: string,
    channel: string,
    conversationId: string,
    userId: string,
  ): Promise<ConversationState> {
    const pk = `TENANT#${tenantId}#CONV#${channel}#${conversationId}`;
    const result = await client.send(new GetCommand({ TableName: tableName, Key: { pk, sk: "STATE" } }));
    return (result.Item?.state as ConversationState | undefined) ?? {
      tenantId,
      channel,
      conversationId,
      userId,
      mode: "ai",
      messages: [],
      verification: { level: "none" },
      revision: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  async saveConversation(state: ConversationState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    state.messages = state.messages.slice(-30);
    const expectedRevision = state.revision ?? 0;
    const next: ConversationState = { ...state, revision: expectedRevision + 1 };
    const pk = `TENANT#${state.tenantId}#CONV#${state.channel}#${state.conversationId}`;

    try {
      await client.send(new PutCommand({
        TableName: tableName,
        Item: { pk, sk: "STATE", entity: "conversation", state: next, updatedAt: next.updatedAt },
        ConditionExpression: expectedRevision === 0
          ? "attribute_not_exists(pk)"
          : "#state.#revision = :expectedRevision",
        ExpressionAttributeNames: expectedRevision === 0
          ? undefined
          : { "#state": "state", "#revision": "revision" },
        ExpressionAttributeValues: expectedRevision === 0
          ? undefined
          : { ":expectedRevision": expectedRevision },
      }));
      state.revision = next.revision;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") {
        throw new ConversationConflictError();
      }
      throw error;
    }
  }

  async commitTurn(
    state: ConversationState,
    externalMessageId: string,
    outbound: OutboundMessage[],
    ttlSeconds = 86400,
  ): Promise<void> {
    state.updatedAt = new Date().toISOString();
    state.messages = state.messages.slice(-30);
    const expectedRevision = state.revision ?? 0;
    const next: ConversationState = { ...state, revision: expectedRevision + 1 };
    const conversationPk = `TENANT#${state.tenantId}#CONV#${state.channel}#${state.conversationId}`;
    const now = Math.floor(Date.now() / 1000);
    const event: EventRecord = {
      externalMessageId,
      tenantId: state.tenantId,
      channel: state.channel,
      conversationId: state.conversationId,
      status: "prepared",
      outbound,
      createdAt: new Date().toISOString(),
    };

    const conversationPut = {
      TableName: tableName,
      Item: {
        pk: conversationPk,
        sk: "STATE",
        entity: "conversation",
        state: next,
        updatedAt: next.updatedAt,
      },
      ConditionExpression: expectedRevision === 0
        ? "attribute_not_exists(pk)"
        : "#state.#revision = :expectedRevision",
      ExpressionAttributeNames: expectedRevision === 0
        ? undefined
        : { "#state": "state", "#revision": "revision" },
      ExpressionAttributeValues: expectedRevision === 0
        ? undefined
        : { ":expectedRevision": expectedRevision },
    };

    try {
      await client.send(new TransactWriteCommand({
        TransactItems: [
          { Put: conversationPut },
          {
            Put: {
              TableName: tableName,
              Item: {
                pk: `EVENT#${externalMessageId}`,
                sk: "EVENT",
                entity: "turn_event",
                event,
                status: "prepared",
                ttl: now + ttlSeconds,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
        ],
      }));
      state.revision = next.revision;
    } catch (error) {
      if (error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException")) {
        throw new ConversationConflictError();
      }
      throw error;
    }
  }

  async setConversationMode(
    tenantId: string,
    channel: string,
    conversationId: string,
    mode: "ai" | "human",
  ): Promise<void> {
    const key = { pk: `TENANT#${tenantId}#CONV#${channel}#${conversationId}`, sk: "STATE" };
    const existing = await client.send(new GetCommand({ TableName: tableName, Key: key }));
    if (!existing.Item?.state) throw new Error("Conversation not found.");

    await client.send(new UpdateCommand({
      TableName: tableName,
      Key: key,
      UpdateExpression: "SET #state.#mode = :mode, #state.updatedAt = :updatedAt, #state.#revision = if_not_exists(#state.#revision, :zero) + :one",
      ExpressionAttributeNames: { "#state": "state", "#mode": "mode", "#revision": "revision" },
      ExpressionAttributeValues: { ":mode": mode, ":updatedAt": new Date().toISOString(), ":zero": 0, ":one": 1 },
    }));
  }

  async getEvent(externalMessageId: string): Promise<EventRecord | undefined> {
    const result = await client.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `EVENT#${externalMessageId}`, sk: "EVENT" },
    }));
    if (result.Item?.event) return result.Item.event as EventRecord;
    if (result.Item?.processedAt) {
      return {
        externalMessageId,
        tenantId: "",
        channel: "",
        conversationId: "",
        status: "completed",
        outbound: [],
        createdAt: String(result.Item.processedAt),
        completedAt: String(result.Item.processedAt),
      };
    }
    return undefined;
  }

  async isEventProcessed(externalMessageId: string): Promise<boolean> {
    return (await this.getEvent(externalMessageId))?.status === "completed";
  }

  async markEventProcessed(externalMessageId: string, ttlSeconds = 86400): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        pk: `EVENT#${externalMessageId}`,
        sk: "EVENT",
        entity: "event_dedupe",
        processedAt: new Date().toISOString(),
        ttl: now + ttlSeconds,
      },
    }));
  }

  async completeEvent(externalMessageId: string): Promise<void> {
    const completedAt = new Date().toISOString();
    await client.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: `EVENT#${externalMessageId}`, sk: "EVENT" },
      UpdateExpression: "SET #status = :completed, event.#status = :completed, event.completedAt = :completedAt",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":completed": "completed", ":completedAt": completedAt },
    }));
  }

  async claimOtpRequestSlot(tenantId: string, userId: string, cooldownSeconds: number): Promise<boolean> {
    if (cooldownSeconds <= 0) return true;
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + cooldownSeconds;
    try {
      await client.send(new PutCommand({
        TableName: tableName,
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
    await client.send(new PutCommand({
      TableName: tableName,
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
    const result = await client.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `TENANT#${tenantId}#OTP#${challengeId}`, sk: "CHALLENGE" },
    }));
    return result.Item?.challenge as OtpChallenge | undefined;
  }

  async consumeOtpChallenge(tenantId: string, challengeId: string, consumedAt: string): Promise<boolean> {
    try {
      await client.send(new UpdateCommand({
        TableName: tableName,
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
    await client.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: `TENANT#${tenantId}#OTP#${challengeId}`, sk: "CHALLENGE" },
      UpdateExpression: "SET challenge.attempts = challenge.attempts + :one",
      ExpressionAttributeValues: { ":one": 1 },
    }));
  }

  async hasConsent(tenantId: string, subjectId: string, policyId: string, version = "1"): Promise<boolean> {
    const result = await client.send(new GetCommand({
      TableName: tableName,
      Key: { pk: `TENANT#${tenantId}#SUBJECT#${subjectId}`, sk: `CONSENT#${policyId}#${version}` },
      ProjectionExpression: "pk",
    }));
    return Boolean(result.Item);
  }

  async recordConsent(record: ConsentRecord): Promise<void> {
    await client.send(new PutCommand({
      TableName: tableName,
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
    await client.send(new PutCommand({
      TableName: tableName,
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

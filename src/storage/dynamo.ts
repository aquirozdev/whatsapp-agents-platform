import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { AgentConfig, ConsentRecord, ConversationState, OtpChallenge } from "../core/types.js";

const tableName = process.env.TABLE_NAME ?? "WhatsappAgentsPlatform";
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

export class PlatformStore {
  async getTenant(tenantId: string): Promise<AgentConfig | undefined> {
    const result = await client.send(new GetCommand({ TableName: tableName, Key: { pk: `TENANT#${tenantId}`, sk: "CONFIG" } }));
    return result.Item?.config as AgentConfig | undefined;
  }

  async getTenantByWhatsAppPhoneNumberId(phoneNumberId: string): Promise<AgentConfig | undefined> {
    const result = await client.send(new QueryCommand({
      TableName: tableName, IndexName: "gsi1", KeyConditionExpression: "gsi1pk = :pk",
      ExpressionAttributeValues: { ":pk": `WA_PHONE#${phoneNumberId}` }, Limit: 1,
    }));
    return result.Items?.[0]?.config as AgentConfig | undefined;
  }

  async putTenant(config: AgentConfig): Promise<void> {
    await client.send(new PutCommand({
      TableName: tableName,
      Item: {
        pk: `TENANT#${config.tenantId}`, sk: "CONFIG",
        gsi1pk: config.whatsapp ? `WA_PHONE#${config.whatsapp.phoneNumberId}` : undefined,
        gsi1sk: config.whatsapp ? `TENANT#${config.tenantId}` : undefined,
        entity: "tenant", config, updatedAt: new Date().toISOString(),
      },
    }));
  }

  async getConversation(tenantId: string, channel: string, conversationId: string, userId: string): Promise<ConversationState> {
    const pk = `TENANT#${tenantId}#CONV#${channel}#${conversationId}`;
    const result = await client.send(new GetCommand({ TableName: tableName, Key: { pk, sk: "STATE" } }));
    return (result.Item?.state as ConversationState | undefined) ?? {
      tenantId, channel: channel as ConversationState["channel"], conversationId, userId, mode: "ai",
      messages: [], verification: { level: "none" }, updatedAt: new Date().toISOString(),
    };
  }

  async saveConversation(state: ConversationState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    state.messages = state.messages.slice(-30);
    await client.send(new PutCommand({
      TableName: tableName,
      Item: { pk: `TENANT#${state.tenantId}#CONV#${state.channel}#${state.conversationId}`, sk: "STATE", entity: "conversation", state, updatedAt: state.updatedAt },
    }));
  }

  async setConversationMode(tenantId: string, channel: string, conversationId: string, mode: "ai" | "human"): Promise<void> {
    await client.send(new UpdateCommand({
      TableName: tableName, Key: { pk: `TENANT#${tenantId}#CONV#${channel}#${conversationId}`, sk: "STATE" },
      UpdateExpression: "SET #state.#mode = :mode, #state.updatedAt = :updatedAt",
      ExpressionAttributeNames: { "#state": "state", "#mode": "mode" },
      ExpressionAttributeValues: { ":mode": mode, ":updatedAt": new Date().toISOString() },
    }));
  }

  async isEventProcessed(externalMessageId: string): Promise<boolean> {
    const result = await client.send(new GetCommand({ TableName: tableName, Key: { pk: `EVENT#${externalMessageId}`, sk: "EVENT" }, ProjectionExpression: "pk" }));
    return Boolean(result.Item);
  }

  async markEventProcessed(externalMessageId: string, ttlSeconds = 86400): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await client.send(new PutCommand({
      TableName: tableName,
      Item: { pk: `EVENT#${externalMessageId}`, sk: "EVENT", entity: "event_dedupe", processedAt: new Date().toISOString(), ttl: now + ttlSeconds },
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
      Item: { pk: `TENANT#${challenge.tenantId}#OTP#${challenge.challengeId}`, sk: "CHALLENGE", entity: "otp", challenge, ttl: challenge.expiresAt + 3600 },
    }));
  }

  async getOtpChallenge(tenantId: string, challengeId: string): Promise<OtpChallenge | undefined> {
    const result = await client.send(new GetCommand({ TableName: tableName, Key: { pk: `TENANT#${tenantId}#OTP#${challengeId}`, sk: "CHALLENGE" } }));
    return result.Item?.challenge as OtpChallenge | undefined;
  }

  async consumeOtpChallenge(tenantId: string, challengeId: string, consumedAt: string): Promise<boolean> {
    try {
      await client.send(new UpdateCommand({
        TableName: tableName, Key: { pk: `TENANT#${tenantId}#OTP#${challengeId}`, sk: "CHALLENGE" },
        UpdateExpression: "SET challenge.consumedAt = :consumedAt", ConditionExpression: "attribute_not_exists(challenge.consumedAt)",
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
      TableName: tableName, Key: { pk: `TENANT#${tenantId}#OTP#${challengeId}`, sk: "CHALLENGE" },
      UpdateExpression: "SET challenge.attempts = challenge.attempts + :one", ExpressionAttributeValues: { ":one": 1 },
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
        entity: "consent", consent: record, acceptedAt: record.acceptedAt,
      },
    }));
  }

  async audit(tenantId: string, action: string, data: Record<string, unknown>): Promise<void> {
    const timestamp = new Date().toISOString();
    const date = timestamp.slice(0, 10);
    await client.send(new PutCommand({
      TableName: tableName,
      Item: { pk: `TENANT#${tenantId}#AUDIT#${date}`, sk: `${timestamp}#${randomUUID()}`, entity: "audit", action, data, timestamp },
    }));
  }
}

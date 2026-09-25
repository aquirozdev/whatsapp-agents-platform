import { randomInt, randomUUID } from "node:crypto";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { ToolContext, ToolExecutionResult } from "../core/types.js";
import { hmacSha256, maskDestination, safeEqualHex } from "../core/security.js";
import { getSecret } from "../providers/secrets.js";
import { PlatformStore } from "../storage/dynamo.js";

const sns = new SNSClient({});
const ses = new SESv2Client({});

export class OtpService {
  constructor(private readonly store: PlatformStore) {}

  async request(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const config = ctx.tenant.otp;
    if (!config?.enabled) return { ok: false, error: { code: "OTP_DISABLED", message: "OTP is not enabled for this tenant." } };
    const channel = input.channel === "email" ? "email" : input.channel === "sms" ? "sms" : undefined;
    const destination = typeof input.destination === "string" ? input.destination.trim() : "";
    if (!channel || !destination) return { ok: false, error: { code: "INVALID_OTP_INPUT", message: "channel and destination are required." } };
    if (config.allowedChannels && !config.allowedChannels.includes(channel)) {
      return { ok: false, error: { code: "OTP_CHANNEL_NOT_ALLOWED", message: `OTP channel ${channel} is not allowed.` } };
    }
    if (channel === "email" && !process.env.OTP_EMAIL_FROM) {
      return { ok: false, error: { code: "OTP_EMAIL_FROM_MISSING", message: "OTP email sender is not configured." } };
    }

    const subjectId = typeof input.subjectId === "string" && input.subjectId.trim()
      ? input.subjectId.trim()
      : ctx.state.userId;

    const cooldownSeconds = config.requestCooldownSeconds ?? 60;
    const claimed = await this.store.claimOtpRequestSlot(
      ctx.tenant.tenantId,
      ctx.state.userId,
      cooldownSeconds,
    );
    if (!claimed) {
      await this.store.audit(ctx.tenant.tenantId, "otp.rate_limited", {
        userId: ctx.state.userId,
        conversationId: ctx.state.conversationId,
        cooldownSeconds,
      });
      return {
        ok: false,
        error: {
          code: "OTP_RATE_LIMITED",
          message: `A verification code was requested recently. Try again in about ${cooldownSeconds} seconds.`,
        },
      };
    }

    const code = String(randomInt(100000, 1000000));
    const challengeId = randomUUID();
    const ttl = config.codeTtlSeconds ?? 300;
    const now = Math.floor(Date.now() / 1000);
    const hmacSecretArn = process.env.OTP_HMAC_SECRET_ARN;
    if (!hmacSecretArn) throw new Error("OTP_HMAC_SECRET_ARN is required.");
    const secret = await getSecret(hmacSecretArn);

    await this.store.putOtpChallenge({
      tenantId: ctx.tenant.tenantId,
      challengeId,
      conversationId: ctx.state.conversationId,
      userId: ctx.state.userId,
      subjectId,
      codeHash: hmacSha256(secret, `${challengeId}:${code}`),
      destinationMasked: maskDestination(destination),
      channel,
      attempts: 0,
      maxAttempts: config.maxAttempts ?? 5,
      expiresAt: now + ttl,
      createdAt: new Date().toISOString(),
    });

    if (channel === "sms") {
      await sns.send(new PublishCommand({
        PhoneNumber: destination,
        Message: `Your verification code is ${code}. It expires in ${Math.ceil(ttl / 60)} minutes.`,
      }));
    } else {
      const from = process.env.OTP_EMAIL_FROM!;
      await ses.send(new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [destination] },
        Content: {
          Simple: {
            Subject: { Data: "Verification code" },
            Body: {
              Text: {
                Data: `Your verification code is ${code}. It expires in ${Math.ceil(ttl / 60)} minutes.`,
              },
            },
          },
        },
      }));
    }

    await this.store.audit(ctx.tenant.tenantId, "otp.requested", {
      challengeId,
      channel,
      destination: maskDestination(destination),
      userId: ctx.state.userId,
      conversationId: ctx.state.conversationId,
    });

    return {
      ok: true,
      data: {
        challengeId,
        channel,
        destination: maskDestination(destination),
        expiresInSeconds: ttl,
      },
    };
  }

  async verify(ctx: ToolContext, input: Record<string, unknown>): Promise<ToolExecutionResult> {
    const challengeId = typeof input.challengeId === "string" ? input.challengeId : "";
    const code = typeof input.code === "string" || typeof input.code === "number" ? String(input.code) : "";
    if (!challengeId || !code) {
      return { ok: false, error: { code: "INVALID_OTP_INPUT", message: "challengeId and code are required." } };
    }

    const challenge = await this.store.getOtpChallenge(ctx.tenant.tenantId, challengeId);
    if (!challenge) {
      return { ok: false, error: { code: "OTP_NOT_FOUND", message: "Verification challenge not found." } };
    }

    if (challenge.userId !== ctx.state.userId || challenge.conversationId !== ctx.state.conversationId) {
      await this.store.audit(ctx.tenant.tenantId, "otp.context_mismatch", {
        challengeId,
        userId: ctx.state.userId,
        conversationId: ctx.state.conversationId,
      });
      return {
        ok: false,
        error: {
          code: "OTP_CONTEXT_MISMATCH",
          message: "Verification challenge does not belong to this conversation.",
        },
      };
    }

    if (challenge.consumedAt) {
      return { ok: false, error: { code: "OTP_ALREADY_USED", message: "Verification code has already been used." } };
    }

    const now = Math.floor(Date.now() / 1000);
    if (challenge.expiresAt <= now) {
      return { ok: false, error: { code: "OTP_EXPIRED", message: "Verification code expired." } };
    }
    if (challenge.attempts >= challenge.maxAttempts) {
      return { ok: false, error: { code: "OTP_LOCKED", message: "Maximum verification attempts reached." } };
    }

    const hmacSecretArn = process.env.OTP_HMAC_SECRET_ARN;
    if (!hmacSecretArn) throw new Error("OTP_HMAC_SECRET_ARN is required.");
    const secret = await getSecret(hmacSecretArn);
    const actual = hmacSha256(secret, `${challengeId}:${code}`);

    if (!safeEqualHex(actual, challenge.codeHash)) {
      await this.store.incrementOtpAttempt(ctx.tenant.tenantId, challengeId);
      await this.store.audit(ctx.tenant.tenantId, "otp.failed", {
        challengeId,
        userId: ctx.state.userId,
      });
      return { ok: false, error: { code: "OTP_INVALID", message: "Verification code is invalid." } };
    }

    const consumedAt = new Date().toISOString();
    const consumed = await this.store.consumeOtpChallenge(ctx.tenant.tenantId, challengeId, consumedAt);
    if (!consumed) {
      return { ok: false, error: { code: "OTP_ALREADY_USED", message: "Verification code has already been used." } };
    }

    const sessionTtl = ctx.tenant.otp?.sessionTtlSeconds ?? 900;
    ctx.state.verification = {
      level: "otp",
      verifiedAt: consumedAt,
      expiresAt: now + sessionTtl,
      subjectId: challenge.subjectId,
    };

    await this.store.audit(ctx.tenant.tenantId, "otp.verified", {
      challengeId,
      userId: ctx.state.userId,
      conversationId: ctx.state.conversationId,
      validForSeconds: sessionTtl,
    });

    return { ok: true, data: { verified: true, validForSeconds: sessionTtl } };
  }
}

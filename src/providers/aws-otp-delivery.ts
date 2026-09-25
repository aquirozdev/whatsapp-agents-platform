import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { OtpDeliveryProvider, OtpDeliveryRequest } from "../ports/otp-delivery.js";

const sns = new SNSClient({});
const ses = new SESv2Client({});

export class AwsOtpDeliveryProvider implements OtpDeliveryProvider {
  constructor(private readonly emailFrom?: string) {}

  async send(request: OtpDeliveryRequest): Promise<void> {
    const message = `Your verification code is ${request.code}. It expires in ${Math.ceil(request.ttlSeconds / 60)} minutes.`;

    if (request.channel === "sms") {
      await sns.send(new PublishCommand({
        PhoneNumber: request.destination,
        Message: message,
      }));
      return;
    }

    if (!this.emailFrom) throw new Error("OTP email sender is not configured.");
    await ses.send(new SendEmailCommand({
      FromEmailAddress: this.emailFrom,
      Destination: { ToAddresses: [request.destination] },
      Content: {
        Simple: {
          Subject: { Data: "Verification code" },
          Body: { Text: { Data: message } },
        },
      },
    }));
  }
}

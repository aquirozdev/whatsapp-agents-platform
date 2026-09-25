import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import type { OtpDeliveryPort } from "../../ports/otp-delivery.js";
import { awsClientOptions } from "./client-options.js";

export class AwsOtpDeliveryProvider implements OtpDeliveryPort {
  private readonly sns = new SNSClient(awsClientOptions());
  private readonly ses = new SESv2Client(awsClientOptions());

  constructor(private readonly emailFrom = process.env.OTP_EMAIL_FROM ?? "") {}

  async sendSms(destination: string, message: string): Promise<void> {
    await this.sns.send(new PublishCommand({ PhoneNumber: destination, Message: message }));
  }

  async sendEmail(destination: string, subject: string, message: string): Promise<void> {
    if (!this.emailFrom) throw new Error("OTP email sender is not configured.");
    await this.ses.send(new SendEmailCommand({
      FromEmailAddress: this.emailFrom,
      Destination: { ToAddresses: [destination] },
      Content: {
        Simple: {
          Subject: { Data: subject },
          Body: { Text: { Data: message } },
        },
      },
    }));
  }
}

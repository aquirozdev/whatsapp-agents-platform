import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { InboundEnvelope } from "../../core/types.js";
import type { DispatchOptions, TurnDispatcher } from "../../ports/dispatcher.js";
import { awsClientOptions } from "./client-options.js";

export class AwsSqsTurnDispatcher implements TurnDispatcher {
  private readonly client = new SQSClient(awsClientOptions());

  constructor(private readonly queueUrl: string) {
    if (!queueUrl) throw new Error("Queue URL is required.");
  }

  async dispatch(turn: InboundEnvelope, options: DispatchOptions): Promise<void> {
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(turn),
      MessageGroupId: options.orderingKey,
      MessageDeduplicationId: options.dedupeKey,
    }));
  }
}

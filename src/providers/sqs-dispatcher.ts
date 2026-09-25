import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { InboundEnvelope } from "../core/types.js";
import type { TurnDispatcher } from "../ports/dispatcher.js";

const sqs = new SQSClient({});

export class SqsFifoTurnDispatcher implements TurnDispatcher {
  constructor(private readonly queueUrl: string) {}

  async dispatch(envelope: InboundEnvelope, orderingKey: string): Promise<void> {
    await sqs.send(new SendMessageCommand({
      QueueUrl: this.queueUrl,
      MessageBody: JSON.stringify(envelope),
      MessageGroupId: orderingKey,
      MessageDeduplicationId: envelope.externalMessageId,
    }));
  }
}

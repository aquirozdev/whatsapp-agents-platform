import type { InboundEnvelope } from "../core/types.js";

export interface TurnDispatcher {
  /**
   * Dispatch with at-least-once delivery and serialization for the same orderingKey.
   * Adapters must preserve this semantic even when the underlying queue does not.
   */
  dispatch(envelope: InboundEnvelope, orderingKey: string): Promise<void>;
}

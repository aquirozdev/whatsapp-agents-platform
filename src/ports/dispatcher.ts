import type { InboundEnvelope } from "../core/types.js";

export interface DispatchOptions {
  orderingKey: string;
  dedupeKey: string;
}

export interface TurnDispatcher {
  dispatch(turn: InboundEnvelope, options: DispatchOptions): Promise<void>;
}

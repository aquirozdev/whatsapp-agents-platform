import type { SecretRef } from "../core/types.js";

export interface SecretProvider {
  get(ref: SecretRef): Promise<string>;
}

import type { SecretRef } from "../core/types.js";

export type SecretReference = string | SecretRef;

export interface SecretProvider {
  get(reference: SecretReference): Promise<string>;
}

export function secretKey(reference: SecretReference): string {
  return typeof reference === "string" ? reference : reference.key;
}

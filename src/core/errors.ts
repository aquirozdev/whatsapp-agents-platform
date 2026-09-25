export type PortableErrorCategory = "validation" | "auth" | "rate_limit" | "timeout" | "unavailable" | "safety" | "internal";

export class PortableRuntimeError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly category: PortableErrorCategory,
    readonly retryable = false,
    readonly metadata: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PortableRuntimeError";
  }
}

export class ModelProviderError extends PortableRuntimeError {
  constructor(message: string, code: string, category: PortableErrorCategory, retryable = false, metadata: Record<string, unknown> = {}) {
    super(message, code, category, retryable, metadata);
    this.name = "ModelProviderError";
  }
}

export function modelErrorFromHttp(status: number, message: string, metadata: Record<string, unknown> = {}): ModelProviderError {
  if (status === 401 || status === 403) return new ModelProviderError(message, "MODEL_AUTH", "auth", false, { ...metadata, status });
  if (status === 429) return new ModelProviderError(message, "MODEL_RATE_LIMIT", "rate_limit", true, { ...metadata, status });
  if (status >= 500) return new ModelProviderError(message, "MODEL_UNAVAILABLE", "unavailable", true, { ...metadata, status });
  return new ModelProviderError(message, "MODEL_INVALID_REQUEST", "validation", false, { ...metadata, status });
}

export function modelTimeoutError(message = "Model request timed out."): ModelProviderError {
  return new ModelProviderError(message, "MODEL_TIMEOUT", "timeout", true);
}

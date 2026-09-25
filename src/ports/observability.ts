export interface MetricPoint {
  name: string;
  value: number;
  unit?: "Count" | "Milliseconds" | "Bytes" | "None";
  dimensions?: Record<string, string>;
}

export interface SpanRecord {
  name: string;
  startedAt: string;
  durationMs: number;
  status: "ok" | "error";
  attributes?: Record<string, string | number | boolean | undefined>;
  errorType?: string;
}

export interface ObservabilityPort {
  metric(point: MetricPoint): void;
  span(record: SpanRecord): void;
  event(name: string, attributes?: Record<string, unknown>): void;
}

export const noopObservability: ObservabilityPort = {
  metric() {},
  span() {},
  event() {},
};

export async function observe<T>(
  observability: ObservabilityPort,
  name: string,
  attributes: Record<string, string | number | boolean | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  try {
    const result = await fn();
    observability.span({ name, startedAt, durationMs: Date.now() - started, status: "ok", attributes });
    return result;
  } catch (error) {
    observability.span({
      name,
      startedAt,
      durationMs: Date.now() - started,
      status: "error",
      attributes,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    throw error;
  }
}

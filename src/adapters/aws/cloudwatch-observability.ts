import type { MetricPoint, ObservabilityPort, SpanRecord } from "../../ports/observability.js";

function safeDimensions(dimensions: Record<string, string> | undefined): Record<string, string> {
  if (!dimensions) return {};
  return Object.fromEntries(Object.entries(dimensions).filter(([, value]) => value.length <= 255));
}

export class AwsCloudWatchObservability implements ObservabilityPort {
  constructor(private readonly namespace = process.env.METRICS_NAMESPACE ?? "WhatsAppAgentsPlatform") {}

  metric(point: MetricPoint): void {
    const dimensions = safeDimensions(point.dimensions);
    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{
          Namespace: this.namespace,
          Dimensions: [Object.keys(dimensions)],
          Metrics: [{ Name: point.name, Unit: point.unit ?? "Count" }],
        }],
      },
      ...dimensions,
      [point.name]: point.value,
    }));
  }

  span(record: SpanRecord): void {
    console.log(JSON.stringify({
      level: record.status === "error" ? "error" : "info",
      message: "span",
      timestamp: new Date().toISOString(),
      trace: {
        name: record.name,
        startedAt: record.startedAt,
        durationMs: record.durationMs,
        status: record.status,
        errorType: record.errorType,
      },
      ...record.attributes,
    }));
  }

  event(name: string, attributes: Record<string, unknown> = {}): void {
    console.log(JSON.stringify({
      level: "info",
      message: name,
      timestamp: new Date().toISOString(),
      ...attributes,
    }));
  }
}

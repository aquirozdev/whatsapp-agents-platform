import type { HttpToolConfig, ToolExecutionResult, ToolErrorCategory } from "../core/types.js";
import type { SecretProvider } from "../ports/secrets.js";
import { getPath, renderValue } from "../core/template.js";

function renderUrl(template: string, input: Record<string, unknown>): string {
  return template.replace(/{{\s*([\w.]+)\s*}}/g, (_, path: string) => {
    const value = getPath(input, path);
    return value === undefined || value === null ? "" : encodeURIComponent(String(value));
  });
}

function originContainsTemplate(template: string): boolean {
  const marker = template.indexOf("://");
  if (marker < 0) return true;
  const pathStart = template.indexOf("/", marker + 3);
  const origin = pathStart < 0 ? template : template.slice(0, pathStart);
  return origin.includes("{{");
}

function validateDestination(config: HttpToolConfig, renderedUrl: string): URL {
  if (originContainsTemplate(config.url)) throw new Error("HTTP tool origins cannot contain templates.");
  const url = new URL(renderedUrl);
  if (url.protocol !== "https:" && !(config.allowInsecureHttp && url.protocol === "http:")) throw new Error("HTTP tool destination must use HTTPS.");
  if (config.allowedHosts?.length && !config.allowedHosts.includes(url.hostname)) throw new Error(`HTTP tool destination host ${url.hostname} is not allowlisted.`);
  return url;
}

function categoryForStatus(status: number): ToolErrorCategory {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "upstream";
  if (status >= 400) return "business";
  return "internal";
}

function retryableStatus(config: HttpToolConfig, status: number): boolean {
  const retryOn = config.retry?.retryOn ?? ["timeout", "rate_limit", "5xx"];
  return (status === 429 && retryOn.includes("rate_limit")) || (status >= 500 && retryOn.includes("5xx"));
}

function canRetryMethod(config: HttpToolConfig): boolean {
  return config.method === "GET" || config.method === "DELETE" || Boolean(config.idempotencyHeader);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeHttpTool(
  config: HttpToolConfig,
  input: Record<string, unknown>,
  secrets: SecretProvider,
  externalMessageId?: string,
): Promise<ToolExecutionResult> {
  const started = Date.now();
  let attempts = 0;
  try {
    const url = validateDestination(config, renderUrl(config.url, input));
    const headers: Record<string, string> = { Accept: "application/json", ...(config.headers ?? {}) };
    for (const [header, secretRef] of Object.entries(config.secretHeaders ?? {})) headers[header] = await secrets.get(secretRef);
    if (config.idempotencyHeader && externalMessageId) headers[config.idempotencyHeader] = externalMessageId;

    const body = config.method === "GET" || config.method === "DELETE"
      ? undefined
      : JSON.stringify(config.bodyTemplate === undefined ? input : renderValue(config.bodyTemplate, input));
    if (body) headers["Content-Type"] ??= "application/json";

    const configuredAttempts = Math.max(1, Math.min(config.retry?.maxAttempts ?? 1, 4));
    const maxAttempts = canRetryMethod(config) ? configuredAttempts : 1;
    const baseDelay = Math.max(25, config.retry?.baseDelayMs ?? 200);
    const maxDelay = Math.max(baseDelay, config.retry?.maxDelayMs ?? 2000);

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        const response = await fetch(url, {
          method: config.method,
          headers,
          body,
          signal: AbortSignal.timeout(config.timeoutMs ?? 10000),
          redirect: "error",
        });

        const requestId = response.headers.get("x-request-id") ?? response.headers.get("request-id") ?? undefined;
        const maxBytes = config.maxResponseBytes ?? 1024 * 1024;
        const declaredLength = Number(response.headers.get("content-length") ?? "0");
        if (declaredLength > maxBytes) {
          return {
            ok: false,
            error: { code: "HTTP_RESPONSE_TOO_LARGE", message: `Upstream response exceeds ${maxBytes} bytes.`, retryable: false, category: "validation" },
            metadata: { latencyMs: Date.now() - started, attempts, statusCode: response.status, upstreamRequestId: requestId },
          };
        }

        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > maxBytes) {
          return {
            ok: false,
            error: { code: "HTTP_RESPONSE_TOO_LARGE", message: `Upstream response exceeds ${maxBytes} bytes.`, retryable: false, category: "validation" },
            metadata: { latencyMs: Date.now() - started, attempts, statusCode: response.status, upstreamRequestId: requestId },
          };
        }

        let data: unknown = text;
        try { data = text ? JSON.parse(text) : null; } catch { /* plain text is allowed */ }

        if (!response.ok) {
          const retryable = retryableStatus(config, response.status) && attempts < maxAttempts;
          if (retryable) {
            await delay(Math.min(maxDelay, baseDelay * 2 ** (attempts - 1)));
            continue;
          }
          return {
            ok: false,
            error: {
              code: `HTTP_${response.status}`,
              message: typeof data === "string" ? data.slice(0, 1000) : JSON.stringify(data).slice(0, 1000),
              retryable: retryableStatus(config, response.status),
              category: categoryForStatus(response.status),
            },
            metadata: { latencyMs: Date.now() - started, attempts, statusCode: response.status, upstreamRequestId: requestId },
          };
        }

        if (config.responsePath) data = getPath(data, config.responsePath);
        return { ok: true, data, metadata: { latencyMs: Date.now() - started, attempts, statusCode: response.status, upstreamRequestId: requestId } };
      } catch (error) {
        const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        const retryable = timeout && (config.retry?.retryOn ?? ["timeout", "rate_limit", "5xx"]).includes("timeout") && attempts < maxAttempts;
        if (retryable) {
          await delay(Math.min(maxDelay, baseDelay * 2 ** (attempts - 1)));
          continue;
        }
        return {
          ok: false,
          error: {
            code: timeout ? "HTTP_TIMEOUT" : "HTTP_TOOL_ERROR",
            message: error instanceof Error ? error.message : "Unknown HTTP tool error",
            retryable: timeout,
            category: timeout ? "timeout" : "internal",
          },
          metadata: { latencyMs: Date.now() - started, attempts },
        };
      }
    }

    return { ok: false, error: { code: "HTTP_RETRY_EXHAUSTED", message: "HTTP tool retries exhausted.", retryable: true, category: "upstream" }, metadata: { latencyMs: Date.now() - started, attempts } };
  } catch (error) {
    return {
      ok: false,
      error: { code: "HTTP_TOOL_ERROR", message: error instanceof Error ? error.message : "Unknown HTTP tool error", retryable: false, category: "validation" },
      metadata: { latencyMs: Date.now() - started, attempts },
    };
  }
}

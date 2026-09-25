import type { HttpToolConfig, SecretRef, ToolExecutionResult } from "../core/types.js";
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

  if (url.protocol !== "https:" && !(config.allowInsecureHttp && url.protocol === "http:")) {
    throw new Error("HTTP tool destination must use HTTPS.");
  }
  if (config.allowedHosts?.length && !config.allowedHosts.includes(url.hostname)) {
    throw new Error(`HTTP tool destination host ${url.hostname} is not allowlisted.`);
  }
  return url;
}

function asSecretRef(value: string | SecretRef): SecretRef {
  return typeof value === "string" ? { key: value } : value;
}

export class HttpToolExecutor {
  constructor(private readonly secrets: SecretProvider) {}

  async execute(
    config: HttpToolConfig,
    input: Record<string, unknown>,
    externalMessageId?: string,
  ): Promise<ToolExecutionResult> {
    try {
      const url = validateDestination(config, renderUrl(config.url, input));
      const headers: Record<string, string> = { Accept: "application/json", ...(config.headers ?? {}) };
      for (const [header, secretRef] of Object.entries(config.secretHeaders ?? {})) {
        headers[header] = await this.secrets.get(asSecretRef(secretRef));
      }
      if (config.idempotencyHeader && externalMessageId) headers[config.idempotencyHeader] = externalMessageId;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10000);
      try {
        const body = config.method === "GET" || config.method === "DELETE"
          ? undefined
          : JSON.stringify(config.bodyTemplate === undefined ? input : renderValue(config.bodyTemplate, input));
        if (body) headers["Content-Type"] ??= "application/json";

        const response = await fetch(url, {
          method: config.method,
          headers,
          body,
          signal: controller.signal,
          redirect: "error",
        });

        const maxBytes = config.maxResponseBytes ?? 1024 * 1024;
        const declaredLength = Number(response.headers.get("content-length") ?? "0");
        if (declaredLength > maxBytes) {
          return { ok: false, error: { code: "HTTP_RESPONSE_TOO_LARGE", message: `Upstream response exceeds ${maxBytes} bytes.` } };
        }

        const text = await response.text();
        if (Buffer.byteLength(text, "utf8") > maxBytes) {
          return { ok: false, error: { code: "HTTP_RESPONSE_TOO_LARGE", message: `Upstream response exceeds ${maxBytes} bytes.` } };
        }

        let data: unknown = text;
        try { data = text ? JSON.parse(text) : null; } catch { /* valid plain text */ }

        if (!response.ok) {
          return {
            ok: false,
            error: {
              code: `HTTP_${response.status}`,
              message: typeof data === "string" ? data.slice(0, 1000) : JSON.stringify(data).slice(0, 1000),
            },
          };
        }
        if (config.responsePath) data = getPath(data, config.responsePath);
        return { ok: true, data };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: "HTTP_TOOL_ERROR",
          message: error instanceof Error ? error.message : "Unknown HTTP tool error",
        },
      };
    }
  }
}

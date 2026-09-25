import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { AgentConfig } from "../core/types.js";
import { validateAgentConfig } from "../core/config-validation.js";
import { PlatformStore } from "../storage/dynamo.js";
import { sha256 } from "../core/security.js";

const host = "127.0.0.1";
const port = Number(process.env.ADMIN_PORT ?? "4173");
const root = resolve(process.cwd());
const tenantsDir = join(root, "tenants");
const templatesDir = join(root, "templates");
const uiPath = join(root, "src", "admin", "ui.html");
const csrfToken = randomBytes(24).toString("hex");
const maxBodyBytes = 2 * 1024 * 1024;
const safeFile = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}\.json$/;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function html(res: ServerResponse, body: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-frame-options": "DENY",
    "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function fileFromPath(pathname: string, prefix: string): string | undefined {
  const raw = decodeURIComponent(pathname.slice(prefix.length));
  const file = basename(raw);
  if (raw !== file || !safeFile.test(file)) return undefined;
  return file;
}

function mutationAllowed(req: IncomingMessage): boolean {
  return req.headers["x-local-admin-token"] === csrfToken;
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => safeFile.test(name)).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function loadConfig(path: string): Promise<AgentConfig> {
  return JSON.parse(await readFile(path, "utf8")) as AgentConfig;
}

async function saveConfig(file: string, config: AgentConfig): Promise<void> {
  await mkdir(tenantsDir, { recursive: true });
  const target = join(tenantsDir, file);
  const tmp = join(tenantsDir, "." + file + "." + process.pid + ".tmp");
  await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await rename(tmp, target);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === "GET" && url.pathname === "/api/configs") {
    const [configs, templates] = await Promise.all([listJsonFiles(tenantsDir), listJsonFiles(templatesDir)]);
    json(res, 200, { configs, templates });
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/config/")) {
    const file = fileFromPath(url.pathname, "/api/config/");
    if (!file) { json(res, 400, { error: "invalid_file_name" }); return true; }
    try { json(res, 200, { file, config: await loadConfig(join(tenantsDir, file)) }); }
    catch { json(res, 404, { error: "config_not_found" }); }
    return true;
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/template/")) {
    const file = fileFromPath(url.pathname, "/api/template/");
    if (!file) { json(res, 400, { error: "invalid_file_name" }); return true; }
    try { json(res, 200, { file, config: await loadConfig(join(templatesDir, file)) }); }
    catch { json(res, 404, { error: "template_not_found" }); }
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/validate") {
    if (!mutationAllowed(req)) { json(res, 403, { error: "forbidden" }); return true; }
    try {
      const config = JSON.parse(await readBody(req)) as AgentConfig;
      const issues = validateAgentConfig(config);
      json(res, issues.length ? 422 : 200, { valid: issues.length === 0, issues });
    } catch (error) {
      json(res, error instanceof Error && error.message === "BODY_TOO_LARGE" ? 413 : 400, { error: "invalid_json" });
    }
    return true;
  }

  if (req.method === "PUT" && url.pathname.startsWith("/api/config/")) {
    if (!mutationAllowed(req)) { json(res, 403, { error: "forbidden" }); return true; }
    const file = fileFromPath(url.pathname, "/api/config/");
    if (!file) { json(res, 400, { error: "invalid_file_name" }); return true; }
    try {
      const config = JSON.parse(await readBody(req)) as AgentConfig;
      const issues = validateAgentConfig(config);
      if (issues.length) { json(res, 422, { valid: false, issues }); return true; }
      await saveConfig(file, config);
      json(res, 200, { ok: true, file, tenantId: config.tenantId });
    } catch (error) {
      json(res, error instanceof Error && error.message === "BODY_TOO_LARGE" ? 413 : 400, { error: "invalid_json" });
    }
    return true;
  }

  if (req.method === "POST" && url.pathname.startsWith("/api/publish/")) {
    if (!mutationAllowed(req)) { json(res, 403, { error: "forbidden" }); return true; }
    const file = fileFromPath(url.pathname, "/api/publish/");
    if (!file) { json(res, 400, { error: "invalid_file_name" }); return true; }
    try {
      const payload = JSON.parse((await readBody(req)) || "{}") as { apiKey?: unknown };
      const config = await loadConfig(join(tenantsDir, file));
      const issues = validateAgentConfig(config);
      if (issues.length) { json(res, 422, { valid: false, issues }); return true; }
      const store = new PlatformStore();
      const existing = await store.getTenant(config.tenantId);
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
      const runtimeConfig: AgentConfig = {
        ...config,
        apiKeyHash: apiKey ? sha256(apiKey) : (config.apiKeyHash ?? existing?.apiKeyHash),
      };

      if (runtimeConfig.whatsapp) {
        const phoneOwner = await store.getTenantByWhatsAppPhoneNumberId(runtimeConfig.whatsapp.phoneNumberId);
        if (phoneOwner && phoneOwner.tenantId !== runtimeConfig.tenantId) {
          json(res, 409, {
            error: "whatsapp_phone_already_assigned",
            tenantId: phoneOwner.tenantId,
          });
          return true;
        }
      }

      await store.putTenant(runtimeConfig);
      json(res, 200, {
        ok: true,
        tenantId: runtimeConfig.tenantId,
        apiKeyUpdated: Boolean(apiKey),
        configVersion: runtimeConfig.configVersion,
        table: process.env.TABLE_NAME ?? "WhatsappAgentsPlatform",
      });
    } catch (error) {
      json(res, 500, { error: "publish_failed", message: error instanceof Error ? error.message : String(error) });
    }
    return true;
  }

  return false;
}

await mkdir(tenantsDir, { recursive: true });
const ui = (await readFile(uiPath, "utf8")).replace("__LOCAL_ADMIN_TOKEN__", csrfToken);

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://" + host + ":" + port);
    if (await handleApi(req, res, url)) return;
    if (req.method === "GET" && url.pathname === "/") return html(res, ui);
    json(res, 404, { error: "not_found" });
  } catch (error) {
    json(res, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  console.log("Local admin: http://" + host + ":" + port);
  console.log("Tenant directory: " + tenantsDir);
  console.log("Press Ctrl+C to stop.");
});

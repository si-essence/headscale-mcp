import { z } from "zod";
import { brandBaseUrl, brandSecret, type BaseUrl, type Secret } from "./brand.js";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "./constants.js";
import { ConnectorError } from "./errors.js";
import { parseToolsets } from "./operations.js";
import { fixedError } from "./zod-messages.js";

const invalid = fixedError("invalid");

const EnvSchema = z.object({
  HEADSCALE_API_KEY: z
    .string({ error: invalid })
    .trim()
    .min(8, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
  HEADSCALE_URL: z.url({ error: invalid }),
  HEADSCALE_ALLOW_WRITES: z.string({ error: invalid }).optional(),
  HEADSCALE_TOOLSETS: z.string({ error: invalid }).optional(),
  HEADSCALE_PER_MINUTE: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  HEADSCALE_TIMEOUT_MS: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  HEADSCALE_CONTACT: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(120, { error: invalid })
    .optional(),
  MCP_TRANSPORT: z.enum(["stdio", "http"], { error: invalid }).optional(),
  PORT: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  HEADSCALE_CACHE_TTL_SEC: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
});

export interface Config {
  apiKey: Secret | undefined;
  baseUrl: BaseUrl;
  allowWrites: boolean;
  toolsets: readonly string[];
  perMinute: number;
  timeoutMs: number;
  contact: string;
  transport: "stdio" | "http";
  port: number;
  cacheTtlSec: number;
  userAgent: string;
}

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return blank(env[name]);
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path =
        issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join(".");
      return `${path} (${issue.code})`;
    })
    .join("; ");
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (raw === undefined) return fallback;
  const parsed = z.number().int().min(min).max(max).safeParse(Number(raw));
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${field} (out_of_range).`);
  }
  return parsed.data;
}

function userAgentFor(contact: string): string {
  const clean = contact
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 120);
  return `${CONNECTOR_NAME}/${CONNECTOR_VERSION} (${clean.length > 0 ? clean : "contact@example.com"})`;
}

export function isTailscaleHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return (
    host === "tailscale.com" ||
    host.endsWith(".tailscale.com") ||
    host === "tailscale.io" ||
    host.endsWith(".tailscale.io")
  );
}

function normalizeBaseUrl(value: string): BaseUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError("config", "Invalid environment: HEADSCALE_URL (invalid_url).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorError("config", "Invalid environment: HEADSCALE_URL (invalid_url).");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConnectorError("config", "Invalid environment: HEADSCALE_URL (userinfo).");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConnectorError("config", "Invalid environment: HEADSCALE_URL (query_or_hash).");
  }
  if (isTailscaleHost(url.hostname)) {
    throw new ConnectorError(
      "config",
      "Invalid environment: HEADSCALE_URL (hosted_vendor). This connector talks only to a self-hosted Headscale server. tailscale.com and tailscale.io hosts are refused.",
    );
  }
  let href = value.replace(/\/+$/, "");
  href = href.replace(/\/api\/v1$/i, "");
  href = href.replace(/\/+$/, "");
  return brandBaseUrl(href);
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
  const urlRaw = read(env, "HEADSCALE_URL");
  if (urlRaw === undefined) {
    throw new ConnectorError(
      "config",
      "Invalid environment: HEADSCALE_URL (required). Set it to your self-hosted Headscale origin, for example http://127.0.0.1:8080.",
    );
  }

  const parsed = EnvSchema.safeParse({
    HEADSCALE_API_KEY: read(env, "HEADSCALE_API_KEY"),
    HEADSCALE_URL: urlRaw,
    HEADSCALE_ALLOW_WRITES: read(env, "HEADSCALE_ALLOW_WRITES"),
    HEADSCALE_TOOLSETS: read(env, "HEADSCALE_TOOLSETS"),
    HEADSCALE_PER_MINUTE: read(env, "HEADSCALE_PER_MINUTE"),
    HEADSCALE_TIMEOUT_MS: read(env, "HEADSCALE_TIMEOUT_MS"),
    HEADSCALE_CONTACT: read(env, "HEADSCALE_CONTACT"),
    MCP_TRANSPORT: read(env, "MCP_TRANSPORT"),
    PORT: read(env, "PORT"),
    HEADSCALE_CACHE_TTL_SEC: read(env, "HEADSCALE_CACHE_TTL_SEC"),
  });
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${issueSummary(parsed.error)}.`);
  }

  const data = parsed.data;
  const apiKey = data.HEADSCALE_API_KEY === undefined ? undefined : brandSecret(data.HEADSCALE_API_KEY);
  const baseUrl = normalizeBaseUrl(data.HEADSCALE_URL);
  const contact = data.HEADSCALE_CONTACT ?? "contact@example.com";
  if (hasControlChar(contact)) {
    throw new ConnectorError("config", "Invalid environment: HEADSCALE_CONTACT (control_character).");
  }
  const userAgent = userAgentFor(contact);
  if (apiKey !== undefined && baseUrl.includes(apiKey)) {
    throw new ConnectorError("config", "Invalid environment: HEADSCALE_URL (contains_secret).");
  }
  if (apiKey !== undefined && (contact.includes(apiKey) || userAgent.includes(apiKey))) {
    throw new ConnectorError("config", "Invalid environment: HEADSCALE_CONTACT (contains_secret).");
  }

  const envTransport = data.MCP_TRANSPORT ?? "stdio";
  const transport = argv.includes("--http") ? "http" : envTransport;
  const allowWrites = data.HEADSCALE_ALLOW_WRITES === "true";
  let toolsets: readonly string[];
  try {
    toolsets = parseToolsets(data.HEADSCALE_TOOLSETS);
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("config", "Invalid environment: HEADSCALE_TOOLSETS.");
  }

  return {
    apiKey,
    baseUrl,
    allowWrites,
    toolsets,
    perMinute: boundedInt(data.HEADSCALE_PER_MINUTE, 30, 1, 10_000, "HEADSCALE_PER_MINUTE"),
    timeoutMs: boundedInt(data.HEADSCALE_TIMEOUT_MS, 20_000, 100, 120_000, "HEADSCALE_TIMEOUT_MS"),
    contact,
    transport,
    port: boundedInt(data.PORT, 3000, 1, 65_535, "PORT"),
    cacheTtlSec: boundedInt(data.HEADSCALE_CACHE_TTL_SEC, 60, 0, 86_400, "HEADSCALE_CACHE_TTL_SEC"),
    userAgent,
  };
}

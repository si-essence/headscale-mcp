import { z } from "zod";
import { ConnectorError } from "./errors.js";

const MAX_DEPTH = 32;

const PATH_BEARING_KEYS = new Set([
  "filename",
  "filepath",
  "file_path",
  "realpath",
  "document_root",
  "script_filename",
  "stack",
  "details",
]);

const recordSchema = z.record(z.string(), z.unknown());

export function isAbsoluteFsPath(value: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) {
    return (
      /^\/(?:tmp|var|home|root|data|datastore|opt|usr|etc|mnt|srv|app|config)\b/i.test(value) ||
      /\.(?:txt|html|htm|json|png|ico|jpg|jpeg|gif|webp|bin|php|log|js|ts|go|db)$/i.test(value)
    );
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("\\\\")) return true;
  return false;
}

export function stripPathsInText(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => (isAbsoluteFsPath(part) ? "[omitted-path]" : part))
    .join("");
}

export function stripServerPaths(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === "string") return isAbsoluteFsPath(value) ? undefined : value;
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      const stripped = stripServerPaths(item, depth + 1);
      if (stripped !== undefined) items.push(stripped);
    }
    return items;
  }
  if (typeof value !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.toLowerCase() === "stack") continue;
    if (PATH_BEARING_KEYS.has(key.toLowerCase())) continue;
    const stripped = stripServerPaths(entry, depth + 1);
    if (stripped === undefined) continue;
    out[key] = stripped;
  }
  return out;
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = entry;
    return out;
  }
  if (Array.isArray(value)) return { items: value };
  if (typeof value === "string") return { text: value };
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { value };
  }
  return { value: null };
}

export function messageFromErrorBody(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const record = recordSchema.safeParse(parsed);
    if (record.success) {
      const message = record.data["message"];
      if (typeof message === "string" && message.trim().length > 0) {
        return stripPathsInText(message);
      }
    }
  } catch {
    return stripPathsInText(text);
  }
  return stripPathsInText(text);
}

const policySchema = z.object({
  policy: z.string().optional(),
  updatedAt: z.string().optional(),
});

export function policyText(value: unknown): string {
  const record = recordSchema.safeParse(value);
  const source = record.success ? record.data : asRecord(value);
  const parsed = policySchema.safeParse(source);
  if (!parsed.success) return "";
  return parsed.data.policy ?? "";
}

export function policyFromBody(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ConnectorError("input", "Policy body must be an object with a policy string.");
  }
  const policy = asRecord(body)["policy"];
  if (policy === undefined) return "";
  if (typeof policy !== "string") {
    throw new ConnectorError("input", "Policy body field policy must be a string.");
  }
  return policy;
}

export const healthSchema = z.looseObject({
  databaseConnectivity: z.boolean().optional(),
});

export function parseHealth(value: unknown): { databaseConnectivity: boolean | undefined } {
  const parsed = healthSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConnectorError("upstream", "Headscale health response did not match the expected shape.");
  }
  return { databaseConnectivity: parsed.data.databaseConnectivity };
}

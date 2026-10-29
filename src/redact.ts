const REDACTED = "[redacted]";
const MIN_SECRET_LENGTH = 8;
const MAX_DEPTH = 32;

const ID_KEY = /id$/i;
const SENSITIVE_FIELD =
  /(secret|token|password|passwd|api[_-]?key|authorization|pincode|pin[_-]?code)/i;
const SENSITIVE_HEADER =
  /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key)$/i;
const EXACT_SECRET = new Set([
  "key",
  "authid",
  "auth_id",
  "apikey",
  "api_key",
  "machinekey",
  "nodekey",
  "discokey",
  "authorization",
  "password",
  "secret",
  "token",
]);

export function isSecretFieldName(key: string): boolean {
  const lower = key.toLowerCase();
  if (EXACT_SECRET.has(lower) || lower === "headers") return true;
  if (ID_KEY.test(key)) return false;
  return SENSITIVE_FIELD.test(key);
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  const seen = new Set<string>();
  for (const secret of secrets) {
    const value = secret.trim();
    if (value.length < MIN_SECRET_LENGTH || seen.has(value)) continue;
    seen.add(value);
    out = out.split(value).join(REDACTED);
    const encoded = encodeURIComponent(value);
    if (encoded !== value) out = out.split(encoded).join(REDACTED);
  }
  out = out.replace(
    /([?&#](?:api_key|apikey|api-key|access_token|token|key|secret|password)=)[^&\s#]+/gi,
    `$1${REDACTED}`,
  );
  out = out.replace(/(authorization:\s*bearer\s+)\S+/gi, `$1${REDACTED}`);
  out = out.replace(/(authorization:\s*token\s+)\S+/gi, `$1${REDACTED}`);
  return out;
}

export function stripUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/g, "[url]");
}

function maskSecret(value: string, secrets: readonly string[]): string {
  const cleaned = redact(value, secrets);
  if (cleaned !== value) return REDACTED;
  if (value.length <= 6) return REDACTED;
  return `${value.slice(0, 6)}…`;
}

export function redactUnknown(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (value === undefined) return undefined;
  if (typeof value === "string") return redact(value, secrets);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (typeof value === "bigint") return redact(value.toString(), secrets);
  if (Array.isArray(value)) {
    return value.map((item) => redactUnknown(item, secrets, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const safeKey = redact(key, secrets);
      out[safeKey] = redactKeyed(safeKey, entry, secrets, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

function redactKeyed(
  key: string,
  value: unknown,
  secrets: readonly string[],
  depth: number,
): unknown {
  if (isSecretFieldName(key)) {
    if (key.toLowerCase() === "headers" && value !== null && typeof value === "object") {
      return redactHeaders(value, secrets, depth);
    }
    if (typeof value === "string") return maskSecret(value, secrets);
    if (Array.isArray(value)) {
      return value.map((item) =>
        typeof item === "string" ? maskSecret(item, secrets) : redactUnknown(item, secrets, depth),
      );
    }
  }
  return redactUnknown(value, secrets, depth);
}

function redactHeaders(value: object, secrets: readonly string[], depth: number): unknown {
  if (Array.isArray(value)) return redactUnknown(value, secrets, depth);
  const out: Record<string, unknown> = {};
  for (const [header, entry] of Object.entries(value)) {
    const safeHeader = redact(header, secrets);
    if (SENSITIVE_HEADER.test(header) || isSecretFieldName(header)) {
      out[safeHeader] = REDACTED;
      continue;
    }
    out[safeHeader] =
      typeof entry === "string" ? redact(entry, secrets) : redactUnknown(entry, secrets, depth);
  }
  return out;
}

/** Replace the caller secret in strings. Leave minted key fields intact for a later reveal. */
export function redactCallerSecrets(value: unknown, secrets: readonly string[], depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof value === "string") return redact(value, secrets);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => redactCallerSecrets(item, secrets, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[redact(key, secrets)] = redactCallerSecrets(entry, secrets, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

export function redactRecord(
  value: Readonly<Record<string, unknown>>,
  secrets: readonly string[],
): Record<string, unknown> {
  const redacted = redactUnknown(value, secrets);
  if (redacted === null || typeof redacted !== "object" || Array.isArray(redacted)) {
    return { error: "Tool result could not be redacted." };
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(redacted)) {
    out[key] = entry;
  }
  return out;
}

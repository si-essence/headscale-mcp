import { asRecord, stripServerPaths } from "./parse.js";
import { redact, redactRecord } from "./redact.js";

interface MintedSecret {
  readonly path: readonly string[];
  readonly value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectMinted(value: unknown, parent: string | undefined, path: string[], out: MintedSecret[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectMinted(item, parent, [...path, String(index)], out);
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const next = [...path, key];
    const mintedField = key === "apiKey" || (key === "key" && parent === "preAuthKey");
    if (mintedField && typeof entry === "string") {
      out.push({ path: next, value: entry });
      continue;
    }
    collectMinted(entry, key, next, out);
  }
}

function setPath(target: unknown, path: readonly string[], value: string): void {
  let cursor: unknown = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (key === undefined) return;
    if (Array.isArray(cursor)) {
      cursor = cursor[Number(key)];
      continue;
    }
    if (!isRecord(cursor)) return;
    cursor = cursor[key];
  }
  const leaf = path[path.length - 1];
  if (leaf === undefined) return;
  if (Array.isArray(cursor)) {
    cursor[Number(leaf)] = value;
    return;
  }
  if (!isRecord(cursor)) return;
  cursor[leaf] = value;
}

export function presentToolResult(
  value: Record<string, unknown>,
  secrets: readonly string[],
): Record<string, unknown> {
  const stripped = asRecord(stripServerPaths(value));
  const reveal = stripped["shown_once"] === true;
  const minted = reveal ? collectMintedList(stripped) : [];
  const redacted = redactRecord(stripped, secrets);
  if (!reveal) return redacted;
  for (const item of minted) {
    setPath(redacted, item.path, redact(item.value, secrets));
  }
  return redacted;
}

function collectMintedList(value: Record<string, unknown>): MintedSecret[] {
  const out: MintedSecret[] = [];
  collectMinted(value, undefined, [], out);
  return out;
}

import { describe, expect, it } from "vitest";
import { createLogger } from "../src/log.js";
import { isSecretFieldName, redact, redactUnknown } from "../src/redact.js";
import { presentToolResult } from "../src/reveal.js";

const KEY = "super-secret/key+value=99";
const ENCODED = encodeURIComponent(KEY);

function assertNoKey(label: string, text: string): void {
  expect(text, label).not.toContain(KEY);
  expect(text, label).not.toContain(ENCODED);
}

describe("redact", () => {
  it("strips the secret, its url encoding, query params, and bearer tokens", () => {
    const raw = [
      `key=${KEY}`,
      `encoded=${ENCODED}`,
      `https://upstream.test/lookup?api_key=${KEY}&x=1`,
      `Authorization: Bearer ${KEY}`,
    ].join("\n");
    const cleaned = redact(raw, [KEY]);
    assertNoKey("redact", cleaned);
    expect(cleaned).toContain("api_key=[redacted]");
    expect(cleaned).toContain("Bearer [redacted]");
  });

  it("redacts nested strings and object keys", () => {
    const cleaned = JSON.stringify(redactUnknown({ [KEY]: [{ title: `see ${KEY}` }] }, [KEY]));
    assertNoKey("nested", cleaned);
    expect(cleaned).toContain("[redacted]");
  });

  it("masks key material and keeps ids and prefixes", () => {
    expect(isSecretFieldName("apiKey")).toBe(true);
    expect(isSecretFieldName("machineKey")).toBe(true);
    expect(isSecretFieldName("prefix")).toBe(false);
    expect(isSecretFieldName("apiKeyId")).toBe(false);
    const cleaned = redactUnknown(
      {
        id: "9",
        prefix: "hskey-",
        apiKey: "hskey-api-full-secret",
        machineKey: "machine-key-secret-value",
        preAuthKey: { id: "3", key: "preauth-secret-value-xx" },
      },
      [],
    );
    const text = JSON.stringify(cleaned);
    expect(text).toContain("9");
    expect(text).toContain("hskey-");
    expect(text).not.toContain("hskey-api-full-secret");
    expect(text).not.toContain("machine-key-secret-value");
    expect(text).not.toContain("preauth-secret-value-xx");
  });

  it("shows a minted api key once and still redacts the caller key", () => {
    const minted = "hskey-api-one-time-secret";
    const shown = presentToolResult(
      {
        shown_once: true,
        note: "This secret is shown only once. List and get calls redact it.",
        result: { apiKey: minted, note: `echo ${KEY}` },
      },
      [KEY],
    );
    const text = JSON.stringify(shown);
    expect(text).toContain(minted);
    expect(text).toContain("shown only once");
    assertNoKey("reveal", text);

    const listed = presentToolResult({ apiKeys: [{ id: "1", prefix: "hskey-", apiKey: minted }] }, [KEY]);
    const listedText = JSON.stringify(listed);
    expect(listedText).not.toContain(minted);
    expect(listedText).toContain("hskey-");
    expect(listedText).toContain("1");
  });

  it("drops stack traces and filesystem paths", () => {
    const shown = presentToolResult(
      {
        message: "node not found",
        stack: "at /usr/src/app/server.ts:9",
        details: ["/home/box/headscale.db"],
        path: "/var/lib/headscale/db.sqlite",
      },
      [],
    );
    const text = JSON.stringify(shown);
    expect(text).toContain("node not found");
    expect(text).not.toContain("stack");
    expect(text).not.toContain("/usr/src");
    expect(text).not.toContain("/home/box");
    expect(text).not.toContain("/var/lib");
  });

  it("redacts logger lines", () => {
    const lines: string[] = [];
    const logger = createLogger([KEY], (line) => {
      lines.push(line);
    });
    logger.error(`upstream said ${KEY}`);
    assertNoKey("logger", lines.join("\n"));
    expect(lines.join("\n")).toContain("[redacted]");
  });
});

describe("registration auth ids", () => {
  it("treats authId as a secret even though it ends in id", () => {
    expect(isSecretFieldName("authId")).toBe(true);
    expect(isSecretFieldName("auth_id")).toBe(true);
    expect(isSecretFieldName("userId")).toBe(false);
  });
});

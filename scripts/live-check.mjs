#!/usr/bin/env node
/**
 * Live check against a real self-hosted Headscale server. Spawns dist/index.js over stdio.
 * Skips when HEADSCALE_URL or HEADSCALE_API_KEY is unset. Does not print secrets.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const token = process.env["HEADSCALE_API_KEY"] ?? "";
const baseUrl = process.env["HEADSCALE_URL"] ?? "";

/** @type {string[]} */
const secrets = [];
if (token.length >= 8) secrets.push(token);

/**
 * @param {string} text
 */
function redact(text) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
    out = out.split(encodeURIComponent(secret)).join("[redacted]");
  }
  out = out.replace(/(authorization:\s*bearer\s+)\S+/gi, "Authorization: Bearer [redacted]");
  out = out.replace(/"(apiKey|key|machineKey|nodeKey|discoKey|password|token)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"');
  return out;
}

/**
 * @param {string} text
 */
function clip(text) {
  let shortened = redact(text).replace(/\s+/g, " ").trim();
  if (shortened.length > 180) shortened = `${shortened.slice(0, 177)}...`;
  return shortened;
}

const writeLine = console.log.bind(console);
const writeError = console.error.bind(console);
console.log = (line) => writeLine(redact(String(line)));
console.error = (line) => writeError(redact(String(line)));

let failed = 0;
/** @type {string[]} */
const rows = [];

/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string} detail
 */
function record(name, ok, detail) {
  if (!ok) failed += 1;
  rows.push(`${ok ? "PASS" : "FAIL"}  ${name}  ${clip(detail)}`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown> | null} json
 */
function resultOf(json) {
  if (!isRecord(json)) return undefined;
  if (json["executed"] === true && isRecord(json["result"])) return json["result"];
  return json;
}

/**
 * @param {unknown} value
 */
function numericId(value) {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return undefined;
}

/**
 * @param {Record<string, unknown> | null} json
 * @param {string} field
 */
function nestedId(json, field) {
  const root = resultOf(json);
  if (!isRecord(root)) return undefined;
  const direct = numericId(root["id"]);
  if (direct !== undefined && field === "id") return direct;
  const nested = root[field];
  if (!isRecord(nested)) return undefined;
  return numericId(nested["id"]);
}

/**
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const block = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = block && typeof block === "object" && "text" in block ? String(block.text) : "";
  for (const secret of secrets) {
    if (secret.length >= 8 && text.includes(secret)) {
      throw new Error("secret leaked into tool output");
    }
  }
  /** @type {Record<string, unknown> | null} */
  let json = null;
  try {
    const parsed = JSON.parse(text);
    json = isRecord(parsed) ? parsed : null;
  } catch {
    json = null;
  }
  return { isError: result.isError === true, text, json };
}

/**
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} name
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @param {(preview: { text: string, json: Record<string, unknown> | null }) => boolean} [previewCheck]
 */
async function writeOp(client, name, tool, args, previewCheck) {
  const preview = await call(client, tool, args);
  const dry =
    !preview.isError &&
    preview.json?.["dry_run"] === true &&
    preview.json?.["executed"] === false &&
    preview.json?.["blocked"] !== true;
  const extra = previewCheck === undefined ? true : previewCheck(preview);
  record(`${name} preview`, dry && extra, dry ? "dry-run" : clip(preview.text));
  if (!dry || !extra) return null;
  const confirmed = await call(client, tool, { ...args, confirm: true });
  record(`${name} confirm`, !confirmed.isError, confirmed.isError ? clip(confirmed.text) : "ok");
  return confirmed.isError ? null : confirmed;
}

function registrationKey() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(24);
  let key = "hskey-authreq-";
  for (const byte of bytes) key += alphabet[byte % alphabet.length] ?? "a";
  return key;
}

const PERMISSIVE = JSON.stringify({
  acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
});

/** @param {string} owner */
const taggedPolicy = (owner) =>
  JSON.stringify({
    tagOwners: { "tag:mcp": [`${owner}@`] },
    acls: [{ action: "accept", src: ["*"], dst: ["*:*"] }],
  });

async function main() {
  if (baseUrl.trim().length === 0 || token.trim().length < 8) {
    writeLine("SKIP  live-check  HEADSCALE_URL and HEADSCALE_API_KEY are unset.");
    return;
  }

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: root,
    env: {
      ...process.env,
      HEADSCALE_URL: baseUrl,
      HEADSCALE_API_KEY: token,
      HEADSCALE_ALLOW_WRITES: "true",
      HEADSCALE_TOOLSETS: "all",
      HEADSCALE_CACHE_TTL_SEC: "0",
      HEADSCALE_PER_MINUTE: "120",
    },
    stderr: "pipe",
  });
  /** @type {string[]} */
  const stderr = [];
  transport.stderr?.on("data", (chunk) => {
    stderr.push(redact(String(chunk)));
  });

  const client = new Client({ name: "live-check", version: "0" });
  await client.connect(transport);

  const stamp = Date.now().toString(36);
  const userName = `u${stamp}`.slice(0, 20);
  const renamed = `v${stamp}`.slice(0, 20);
  let activeName = userName;
  const nodeName = `n${stamp}`.slice(0, 20);
  const nodeRenamed = `m${stamp}`.slice(0, 20);
  const route = "10.67.1.0/24";
  /** @type {string | undefined} */
  let userId;
  /** @type {string | undefined} */
  let preAuthId;
  /** @type {string | undefined} */
  let apiPrefix;
  /** @type {string | undefined} */
  let nodeId;
  /** @type {string} */
  let originalPolicy = "";
  let policyRead = false;

  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    record(
      "tools",
      names.length === 8 && names.includes("headscale_debug") && names.includes("headscale_policy"),
      `${names.length} tools`,
    );

    const health = await call(client, "headscale_meta", { action: "health" });
    const healthBody = resultOf(health.json);
    record(
      "health",
      !health.isError && isRecord(healthBody) && healthBody["databaseConnectivity"] === true,
      health.isError ? clip(health.text) : "ok",
    );

    const createdUser = await writeOp(client, "user create", "headscale_users", {
      action: "create_user",
      body: { name: userName },
    });
    userId = createdUser === null ? undefined : nestedId(createdUser.json, "user");
    record("user id", userId !== undefined, userId === undefined ? "missing" : "ok");

    const users = await call(client, "headscale_users", { action: "list_users" });
    record(
      "user list",
      !users.isError && users.text.includes(userName),
      users.isError ? clip(users.text) : "ok",
    );

    if (userId !== undefined) {
      const renamedUser = await writeOp(client, "user rename", "headscale_users", {
        action: "rename_user",
        params: { oldId: userId, newName: renamed },
      });
      record("user rename id", renamedUser !== null, renamedUser === null ? "missing" : "ok");
      if (renamedUser !== null) activeName = renamed;
    }

    if (userId !== undefined) {
      const minted = await writeOp(client, "preauth create", "headscale_preauth_keys", {
        action: "create_pre_auth_key",
        body: { user: userId, reusable: false, ephemeral: false },
      });
      const pre = minted === null ? undefined : resultOf(minted.json);
      const preAuth = isRecord(pre) && isRecord(pre["preAuthKey"]) ? pre["preAuthKey"] : undefined;
      const preKey = isRecord(preAuth) && typeof preAuth["key"] === "string" ? preAuth["key"] : undefined;
      preAuthId = isRecord(preAuth) ? numericId(preAuth["id"]) : undefined;
      if (preKey !== undefined) secrets.push(preKey);
      const revealed =
        minted !== null &&
        preKey !== undefined &&
        minted.text.includes(preKey) &&
        minted.text.includes("shown only once");
      record("preauth reveal once", revealed, revealed ? "once" : "missing");
      const preList = await call(client, "headscale_preauth_keys", { action: "list_pre_auth_keys" });
      const hidden = preKey !== undefined && !preList.text.includes(preKey) && !preList.isError;
      record("preauth list redacts", hidden, hidden ? "redacted" : "not redacted");
      if (preAuthId !== undefined) {
        await writeOp(client, "preauth expire", "headscale_preauth_keys", {
          action: "expire_pre_auth_key",
          body: { id: preAuthId },
        });
        const deletedPre = await writeOp(client, "preauth delete", "headscale_preauth_keys", {
          action: "delete_pre_auth_key",
          query: { id: preAuthId },
        });
        if (deletedPre !== null) preAuthId = undefined;
      }
    }

    const beforeKeys = await call(client, "headscale_api_keys", { action: "list_api_keys" });
    const before = new Set(prefixesFrom(beforeKeys.json));
    const expiration = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const mintedKey = await writeOp(client, "api key create", "headscale_api_keys", {
      action: "create_api_key",
      body: { expiration },
    });
    const keyBody = mintedKey === null ? undefined : resultOf(mintedKey.json);
    const fullKey = isRecord(keyBody) && typeof keyBody["apiKey"] === "string" ? keyBody["apiKey"] : undefined;
    if (fullKey !== undefined) secrets.push(fullKey);
    record(
      "api key reveal once",
      mintedKey !== null && fullKey !== undefined && mintedKey.text.includes(fullKey) && mintedKey.text.includes("shown only once"),
      "checked",
    );
    const afterKeys = await call(client, "headscale_api_keys", { action: "list_api_keys" });
    const createdPrefixes = prefixesFrom(afterKeys.json).filter((prefix) => !before.has(prefix));
    apiPrefix = createdPrefixes
      .map((prefix) => prefix.replace(/\*+$/, ""))
      .filter((prefix) => fullKey !== undefined && fullKey.startsWith(prefix))
      .sort((a, b) => b.length - a.length)[0];
    const listHides = fullKey !== undefined && !afterKeys.text.includes(fullKey) && !afterKeys.isError;
    record("api key list redacts", listHides, listHides ? "redacted" : "not redacted");
    record("api key throwaway prefix", apiPrefix !== undefined, apiPrefix === undefined ? "missing" : "matched");
    if (apiPrefix !== undefined && token.startsWith(apiPrefix)) {
      record("api key not caller", false, "refusing to touch the caller key");
      apiPrefix = undefined;
    }
    if (apiPrefix !== undefined) {
      await writeOp(client, "api key expire", "headscale_api_keys", {
        action: "expire_api_key",
        body: { prefix: apiPrefix },
      });
      const deletedKey = await writeOp(client, "api key delete", "headscale_api_keys", {
        action: "delete_api_key",
        params: { prefix: apiPrefix },
      });
      if (deletedKey !== null) apiPrefix = undefined;
    }

    const policy = await call(client, "headscale_policy", { action: "get_policy" });
    const policyBody = resultOf(policy.json);
    originalPolicy = isRecord(policyBody) && typeof policyBody["policy"] === "string" ? policyBody["policy"] : "";
    policyRead = !policy.isError;
    record("policy get", policyRead, policy.isError ? clip(policy.text) : "ok");

    const checked = await call(client, "headscale_policy", {
      action: "check_policy",
      body: { policy: PERMISSIVE },
    });
    record("policy check", !checked.isError, checked.isError ? clip(checked.text) : "ok");

    const diff = await call(client, "headscale_policy", {
      action: "diff",
      body: { policy: `${PERMISSIVE}\n` },
    });
    const diffRecord = isRecord(diff.json) && isRecord(diff.json["diff"]) ? diff.json["diff"] : undefined;
    record(
      "policy diff",
      !diff.isError && diffRecord !== undefined && typeof diffRecord["added"] === "number" && typeof diffRecord["removed"] === "number",
      diff.isError ? clip(diff.text) : "ok",
    );

    const setPolicy = await writeOp(
      client,
      "policy set",
      "headscale_policy",
      { action: "set_policy", body: { policy: PERMISSIVE } },
      (preview) => preview.text.includes("lock all nodes") && preview.text.includes("diff"),
    );
    record("policy set applied", setPolicy !== null, setPolicy === null ? "missing" : "ok");
    await restorePolicy(client, originalPolicy, policyRead);

    if (userId !== undefined) {
      const tagged = await writeOp(client, "policy tags", "headscale_policy", {
        action: "set_policy",
        body: { policy: taggedPolicy(activeName) },
      });
      const regKey = registrationKey();
      secrets.push(regKey);
      const createdNode = await writeOp(client, "debug node", "headscale_debug", {
        action: "debug_create_node",
        body: { user: activeName, key: regKey, name: nodeName, routes: [route] },
      });
      // The debug call only creates a pending registration (node id 0). Registering it makes a real node.
      const registered =
        createdNode === null
          ? null
          : await writeOp(client, "auth register pending node", "headscale_auth", {
              action: "auth_register",
              body: { user: activeName, authId: regKey },
            });
      nodeId = registered === null ? undefined : nestedId(registered.json, "node");
      record("debug node id", nodeId !== undefined, nodeId === undefined ? "missing" : "ok");
      record("policy tags ready", tagged !== null, tagged === null ? "missing" : "ok");
      if (nodeId !== undefined) {
        const got = await call(client, "headscale_nodes", {
          action: "get_node",
          params: { nodeId },
        });
        record("node get", !got.isError && got.text.includes(nodeId), got.isError ? clip(got.text) : "ok");
        const nodes = await call(client, "headscale_nodes", {
          action: "list_nodes",
          query: { user: activeName },
        });
        record("node list", !nodes.isError, nodes.isError ? clip(nodes.text) : "ok");
        await writeOp(client, "node rename", "headscale_nodes", {
          action: "rename_node",
          params: { nodeId, newName: nodeRenamed },
        });
        await writeOp(client, "node tags", "headscale_nodes", {
          action: "set_tags",
          params: { nodeId },
          body: { tags: ["tag:mcp"] },
        });
        await writeOp(client, "node routes", "headscale_nodes", {
          action: "set_approved_routes",
          params: { nodeId },
          body: { routes: [route] },
        });
        await writeOp(client, "node expire", "headscale_nodes", {
          action: "expire_node",
          params: { nodeId },
          query: { expiry: "2020-01-01T00:00:00Z" },
        });
        const deletedNode = await writeOp(client, "node delete", "headscale_nodes", {
          action: "delete_node",
          params: { nodeId },
        });
        if (deletedNode !== null) nodeId = undefined;
      }
    }

    const missing = await call(client, "headscale_nodes", {
      action: "get_node",
      params: { nodeId: "999999999999" },
    });
    const cleanMiss =
      missing.isError &&
      (missing.text.includes("404") || missing.text.includes("not-found") || missing.text.includes("not found")) &&
      !missing.text.includes("/tmp") &&
      !missing.text.includes("/home") &&
      !missing.text.includes("/var") &&
      !missing.text.toLowerCase().includes("stack");
    record("unknown node", cleanMiss, cleanMiss ? "not-found" : clip(missing.text));

    if (userId !== undefined) {
      const deletedUser = await writeOp(client, "user delete", "headscale_users", {
        action: "delete_user",
        params: { id: userId },
      });
      if (deletedUser !== null) userId = undefined;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "live-check failed";
    record("live-check", false, message);
  } finally {
    try {
      if (nodeId !== undefined) {
        await call(client, "headscale_nodes", {
          action: "delete_node",
          params: { nodeId },
          confirm: true,
        });
      }
      if (preAuthId !== undefined) {
        await call(client, "headscale_preauth_keys", {
          action: "delete_pre_auth_key",
          query: { id: preAuthId },
          confirm: true,
        });
      }
      if (apiPrefix !== undefined) {
        await call(client, "headscale_api_keys", {
          action: "delete_api_key",
          params: { prefix: apiPrefix },
          confirm: true,
        });
      }
      if (userId !== undefined) {
        await call(client, "headscale_users", {
          action: "delete_user",
          params: { id: userId },
          confirm: true,
        });
      }
      if (policyRead) await restorePolicy(client, originalPolicy, true);
    } catch {
      record("cleanup", false, "cleanup failed");
    }
    await client.close();
  }

  const leaked = stderr.join("").includes(token);
  if (leaked) record("stderr", false, "secret leaked");
  for (const row of rows) writeLine(row);
  writeLine(`failed=${failed}`);
  if (failed > 0) process.exit(1);
}

/**
 * @param {Record<string, unknown> | null} json
 * @returns {string[]}
 */
function prefixesFrom(json) {
  const root = resultOf(json);
  const list = isRecord(root) && Array.isArray(root["apiKeys"]) ? root["apiKeys"] : [];
  /** @type {string[]} */
  const prefixes = [];
  for (const item of list) {
    if (isRecord(item) && typeof item["prefix"] === "string" && item["prefix"].length > 0) {
      prefixes.push(item["prefix"]);
    }
  }
  return prefixes;
}

/**
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} original
 * @param {boolean} enabled
 */
async function restorePolicy(client, original, enabled) {
  if (!enabled) return;
  const empty = original.trim() === "";
  const target = empty ? PERMISSIVE : original;
  const restored = await call(client, "headscale_policy", {
    action: "set_policy",
    body: { policy: target },
    confirm: true,
  });
  const detail = restored.isError
    ? clip(restored.text)
    : empty
      ? "original empty, restored the permissive default"
      : "restored";
  record("policy restore", !restored.isError, detail);
}

await main();

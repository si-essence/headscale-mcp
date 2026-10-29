import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import { OPERATIONS, toolIsWrite, toolNames, type Operation } from "../src/operations.js";
import { decideWrite } from "../src/write-gate.js";
import {
  BASE,
  TOKEN,
  expectAuth,
  jsonFetch,
  jsonResponse,
  runtimeFor,
  type CapturedRequest,
} from "./harness.js";
import { connectServer } from "./mcp.js";
import { readToolText } from "./result.js";

const TOOL_NAMES = toolNames();
const WRITE_OPS = OPERATIONS.filter((operation) => operation.write);
const READ_OPS = OPERATIONS.filter((operation) => !operation.write);
const REG_KEY = "abcdefghijklmnopqrstuvwx";
const MINTED = "minted-should-mask";
const PREAUTH = "preauth-secret-value-xx";
const MACHINE = "machine-key-secret-value";

function isDiff(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("added" in value) || !("removed" in value)) return false;
  return typeof value.added === "number" && typeof value.removed === "number";
}

function leakyResponse(): Response {
  return jsonResponse({
    id: "1",
    name: `hello ${TOKEN}`,
    databaseConnectivity: true,
    policy: "current-line\nkeep\n",
    updatedAt: "2026-01-01T00:00:00.000Z",
    apiKey: MINTED,
    machineKey: MACHINE,
    nodeKey: "node-key-secret-value",
    discoKey: "disco-key-secret-value",
    prefix: "hspref",
    apiKeyId: "keep-id",
    preAuthKey: { id: "9", key: PREAUTH },
    stack: "Error\n    at /usr/src/app/server.ts:9:1",
    details: [{ debug: "/home/box/headscale.db" }],
    users: [{ id: "1", name: "sample" }],
    node: { id: "1", name: "sample" },
  });
}

function argsFor(operation: Operation): Record<string, unknown> {
  const args: Record<string, unknown> = { action: operation.action };
  if (Object.keys(operation.sampleParams).length > 0) args["params"] = operation.sampleParams;
  if (Object.keys(operation.sampleQuery).length > 0) args["query"] = operation.sampleQuery;
  if (operation.sampleBody !== undefined) args["body"] = operation.sampleBody;
  return args;
}

async function withClient(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv,
  run: (client: Client) => Promise<void>,
): Promise<void> {
  const runtime = runtimeFor(fetchImpl, extra);
  const connected = await connectServer(runtime);
  try {
    await run(connected.client);
  } finally {
    await connected.close();
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean; json: Record<string, unknown> | null }> {
  const result = readToolText(await client.callTool({ name, arguments: args }));
  expect(result.text).not.toContain(TOKEN);
  if (result.isError) return { ...result, json: null };
  return { ...result, json: JSON.parse(result.text) as Record<string, unknown> };
}

describe("headscale tools", () => {
  it("publishes every tool with warnings in the description and confirm only on writes", async () => {
    const { fetchImpl } = jsonFetch(() => leakyResponse());
    await withClient(fetchImpl, {}, async (client) => {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expect(names).toEqual(TOOL_NAMES);
      for (const tool of listed.tools) {
        expect((tool.description ?? "").trim().length).toBeGreaterThan(20);
        const schema = JSON.stringify(tool.inputSchema);
        if (toolIsWrite(tool.name)) expect(schema).toContain("confirm");
        else expect(schema).not.toContain("confirm");
      }
      const policy = listed.tools.find((tool) => tool.name === "headscale_policy");
      expect(policy?.description ?? "").toContain("lock all nodes");
      const nodes = listed.tools.find((tool) => tool.name === "headscale_nodes");
      expect(nodes?.description ?? "").toContain("deletes a node");
      expect(nodes?.description ?? "").toContain("subnet routes");
      const debug = listed.tools.find((tool) => tool.name === "headscale_debug");
      expect(debug?.description ?? "").toContain("TEST ONLY");
      const keys = listed.tools.find((tool) => tool.name === "headscale_api_keys");
      expect(keys?.description ?? "").toContain("shown once");
      const preauth = listed.tools.find((tool) => tool.name === "headscale_preauth_keys");
      expect(preauth?.description ?? "").toContain("pre-auth key");
    });
  });

  it("scopes the published set to HEADSCALE_TOOLSETS and keeps debug off by default", async () => {
    const { fetchImpl } = jsonFetch(() => leakyResponse());
    await withClient(fetchImpl, { HEADSCALE_TOOLSETS: "nodes,policy" }, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "headscale_nodes",
        "headscale_policy",
      ]);
    });
    await withClient(fetchImpl, { HEADSCALE_TOOLSETS: undefined }, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "headscale_meta",
        "headscale_nodes",
        "headscale_policy",
        "headscale_users",
      ]);
      expect(listed.tools.some((tool) => tool.name === "headscale_debug")).toBe(false);
      expect(listed.tools.some((tool) => tool.name === "headscale_api_keys")).toBe(false);
    });
  });
});

describe("every registered tool", () => {
  it("guards every tool with a confirmed call and every write with a preview", async () => {
    const previewed = new Set<string>();
    const confirmed = new Set<string>();

    for (const operation of READ_OPS) {
      const { fetchImpl, calls } = jsonFetch((captured) => {
        expectAuth(captured);
        return leakyResponse();
      });
      await withClient(fetchImpl, {}, async (client) => {
        const result = await call(client, operation.tool, argsFor(operation));
        expect(result.isError, `${operation.tool} ${operation.action}`).toBe(false);
        expect(result.text).not.toContain(MACHINE);
        expect(result.text).not.toContain("/usr/src");
        expect(result.text).not.toContain("/home/box");
        expect(result.text).not.toContain("stack");
        if (!operation.revealSecret) {
          expect(result.text).not.toContain(MINTED);
          expect(result.text).not.toContain(PREAUTH);
        }
        expect(calls.length).toBeGreaterThan(0);
        expect(calls[0]?.authorization).toBe(`Bearer ${TOKEN}`);
        expect(calls[0]?.method).toBe(operation.method);
        expect(calls[0]?.url.startsWith(`${BASE}/api/v1`)).toBe(true);
        if (operation.action === "diff") {
          expect(calls).toHaveLength(1);
          expect(calls[0]?.method).toBe("GET");
          expect(calls[0]?.body).toBeUndefined();
          expect(isDiff(result.json?.["diff"])).toBe(true);
        }
        if (operation.action === "check_policy") {
          expect(calls[0]?.method).toBe("POST");
          expect(calls[0]?.url).toBe(`${BASE}/api/v1/policy/check`);
        }
        confirmed.add(operation.tool);
      });
    }

    for (const operation of WRITE_OPS) {
      const { fetchImpl, calls } = jsonFetch((captured) => {
        expectAuth(captured);
        return leakyResponse();
      });
      await withClient(fetchImpl, {}, async (client) => {
        const preview = await call(client, operation.tool, argsFor(operation));
        expect(preview.isError, `${operation.tool} ${operation.action} preview`).toBe(false);
        expect(preview.json).toMatchObject({
          executed: false,
          dry_run: true,
          blocked: false,
          method: operation.method,
        });
        expect(String(preview.json?.["path"]).startsWith("api/v1")).toBe(true);
        expect(preview.text).not.toContain(REG_KEY);
        expect(preview.text).not.toContain(MINTED);
        if (operation.warnings.length > 0) {
          expect(preview.text).toContain(operation.warnings[0] ?? "");
        }
        if (operation.action === "set_policy") {
          expect(calls).toHaveLength(1);
          expect(calls[0]?.method).toBe("GET");
          expect(calls[0]?.url).toBe(`${BASE}/api/v1/policy`);
          expect(isDiff(preview.json?.["diff"])).toBe(true);
          expect(preview.text).toContain("lock all nodes");
        } else {
          expect(calls).toHaveLength(0);
        }
        previewed.add(operation.tool);

        const executed = await call(client, operation.tool, { ...argsFor(operation), confirm: true });
        expect(executed.isError, `${operation.tool} ${operation.action} confirm`).toBe(false);
        expect(executed.json).toMatchObject({ executed: true, dry_run: false });
        expect(executed.text).not.toContain(MACHINE);
        expect(executed.text).not.toContain("/usr/src");
        expect(executed.text).not.toContain("stack");
        const sent = calls[calls.length - 1];
        expect(sent?.method).toBe(operation.method);
        expect(sent?.authorization).toBe(`Bearer ${TOKEN}`);
        if (operation.revealSecret) {
          expect(executed.text).toContain("shown only once");
          expect(executed.text).toContain(MINTED);
        } else {
          expect(executed.text).not.toContain(MINTED);
          expect(executed.text).not.toContain(PREAUTH);
        }
        confirmed.add(operation.tool);
      });
    }

    expect([...previewed].sort()).toEqual(TOOL_NAMES.filter((name) => toolIsWrite(name)).sort());
    expect([...confirmed].sort()).toEqual([...TOOL_NAMES].sort());
    expect(READ_OPS.length + WRITE_OPS.length).toBe(OPERATIONS.length);
    for (const name of TOOL_NAMES) expect(confirmed.has(name)).toBe(true);
  });

  it("rejects confirm false and the string true", async () => {
    const { fetchImpl, calls } = jsonFetch(() => leakyResponse());
    await withClient(fetchImpl, {}, async (client) => {
      const asFalse = await call(client, "headscale_nodes", {
        action: "delete_node",
        params: { nodeId: "1" },
        confirm: false,
      });
      expect(asFalse.isError).toBe(true);
      const asString = await call(client, "headscale_nodes", {
        action: "delete_node",
        params: { nodeId: "1" },
        confirm: "true",
      });
      expect(asString.isError).toBe(true);
      expect(asString.text.toLowerCase()).toContain("confirm");
      expect(calls).toHaveLength(0);
    });
  });
});

describe("write gate", () => {
  it("blocks confirm when HEADSCALE_ALLOW_WRITES is not true and does not call", async () => {
    const { fetchImpl, calls } = jsonFetch(() => leakyResponse());
    await withClient(fetchImpl, { HEADSCALE_ALLOW_WRITES: "false" }, async (client) => {
      const result = await call(client, "headscale_nodes", {
        action: "delete_node",
        params: { nodeId: "1" },
        confirm: true,
      });
      expect(result.json).toMatchObject({
        executed: false,
        dry_run: true,
        blocked: true,
        method: "DELETE",
      });
      expect(result.text).toContain("HEADSCALE_ALLOW_WRITES");
      expect(result.text).toContain("deletes a node");
      expect(calls).toHaveLength(0);
    });
  });

  it("previews when writes are enabled but confirm is omitted", async () => {
    const { fetchImpl, calls } = jsonFetch(() => leakyResponse());
    await withClient(fetchImpl, { HEADSCALE_ALLOW_WRITES: "true" }, async (client) => {
      const result = await call(client, "headscale_users", {
        action: "delete_user",
        params: { id: "1" },
      });
      expect(result.json).toMatchObject({ executed: false, dry_run: true, blocked: false, method: "DELETE" });
      expect(result.text).toContain("deletes a user");
      expect(calls).toHaveLength(0);
    });
  });

  it("decideWrite requires the boolean true and the env flag together", () => {
    const plan = {
      method: "DELETE" as const,
      path: "api/v1/node/1",
      query: undefined,
      body: undefined,
      summary: "Delete a node.",
      warnings: ["This deletes a node and removes it from the tailnet."],
      revealSecret: false,
    };
    expect(decideWrite(true, undefined, plan, []).kind).toBe("preview");
    expect(decideWrite(false, true, plan, []).kind).toBe("preview");
    expect(decideWrite(true, true, plan, []).kind).toBe("execute");
  });

  it("refuses an empty policy on confirm and still previews it", async () => {
    const { fetchImpl, calls } = jsonFetch(() => leakyResponse());
    await withClient(fetchImpl, {}, async (client) => {
      const preview = await call(client, "headscale_policy", {
        action: "set_policy",
        body: { policy: "   " },
      });
      expect(preview.json).toMatchObject({ dry_run: true, method: "PUT" });
      expect(calls.some((item) => item.method === "PUT")).toBe(false);
      const refused = await call(client, "headscale_policy", {
        action: "set_policy",
        body: { policy: "" },
        confirm: true,
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("empty policy");
      expect(calls.some((item) => item.method === "PUT")).toBe(false);
    });
  });

  it("treats policy check as a read even when writes are disabled", async () => {
    const { fetchImpl, calls } = jsonFetch((captured) => {
      expectAuth(captured);
      return jsonResponse({});
    });
    await withClient(fetchImpl, { HEADSCALE_ALLOW_WRITES: "false" }, async (client) => {
      const result = await call(client, "headscale_policy", {
        action: "check_policy",
        body: { policy: '{"acls":[]}' },
      });
      expect(result.isError).toBe(false);
      expect(result.json?.["dry_run"]).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("POST");
    });
  });
});

describe("secrets", () => {
  it("returns a minted api key once and redacts it on list", async () => {
    const minted = "hskey-api-one-time-secret";
    const { fetchImpl, calls } = jsonFetch((captured) => {
      expectAuth(captured);
      if (captured.method === "POST") return jsonResponse({ apiKey: minted });
      return jsonResponse({
        apiKeys: [{ id: "4", prefix: "hskey-", apiKey: minted }],
      });
    });
    await withClient(fetchImpl, {}, async (client) => {
      const preview = await call(client, "headscale_api_keys", {
        action: "create_api_key",
        body: { expiration: "2026-12-01T00:00:00.000Z" },
      });
      expect(preview.json?.["dry_run"]).toBe(true);
      expect(preview.text).not.toContain(minted);
      expect(calls).toHaveLength(0);
      const created = await call(client, "headscale_api_keys", {
        action: "create_api_key",
        body: { expiration: "2026-12-01T00:00:00.000Z" },
        confirm: true,
      });
      expect(created.text).toContain(minted);
      expect(created.text).toContain("shown only once");
      expect(created.text).not.toContain(TOKEN);
      const listed = await call(client, "headscale_api_keys", { action: "list_api_keys" });
      expect(listed.text).not.toContain(minted);
      expect(listed.text).toContain("hskey-");
      expect(listed.text).toContain("4");
    });
  });

  it("returns a pre-auth key once and redacts it on list", async () => {
    const minted = "hskey-auth-one-time-secret";
    const { fetchImpl } = jsonFetch((captured) => {
      if (captured.method === "POST") {
        return jsonResponse({ preAuthKey: { id: "9", key: minted, user: { id: "1" } } });
      }
      return jsonResponse({ preAuthKeys: [{ id: "9", key: minted }] });
    });
    await withClient(fetchImpl, {}, async (client) => {
      const created = await call(client, "headscale_preauth_keys", {
        action: "create_pre_auth_key",
        body: { user: "1" },
        confirm: true,
      });
      expect(created.text).toContain(minted);
      expect(created.text).toContain("shown only once");
      const listed = await call(client, "headscale_preauth_keys", { action: "list_pre_auth_keys" });
      expect(listed.text).not.toContain(minted);
      expect(listed.text).toContain("9");
      expect(listed.text).toContain("hskey-");
    });
  });

  it("redacts the caller api key even when a create response echoes it", async () => {
    const { fetchImpl } = jsonFetch(() => jsonResponse({ apiKey: TOKEN, note: `see ${TOKEN}` }));
    await withClient(fetchImpl, {}, async (client) => {
      const created = await call(client, "headscale_api_keys", {
        action: "create_api_key",
        body: { expiration: "2026-12-01T00:00:00.000Z" },
        confirm: true,
      });
      expect(created.isError).toBe(false);
      expect(created.text).not.toContain(TOKEN);
      expect(created.text).toContain("[redacted]");
    });
  });

  it("masks registration keys in previews", async () => {
    const { fetchImpl, calls } = jsonFetch(() => jsonResponse({ node: { id: "1" } }));
    await withClient(fetchImpl, {}, async (client) => {
      const preview = await call(client, "headscale_debug", {
        action: "debug_create_node",
        body: { user: "sample-user", key: REG_KEY, name: "sample-node", routes: [] },
      });
      expect(preview.text).not.toContain(REG_KEY);
      expect(preview.text).toContain("TEST ONLY");
      expect(calls).toHaveLength(0);
      const registered = await call(client, "headscale_nodes", {
        action: "register_node",
        query: { user: "sample-user", key: REG_KEY },
      });
      expect(registered.text).not.toContain(REG_KEY);
      expect(registered.text).toContain("admit a device");
    });
  });
});

describe("ids and errors", () => {
  it("rejects a non-numeric node id before any request", async () => {
    const { fetchImpl, calls } = jsonFetch(() => leakyResponse());
    await withClient(fetchImpl, {}, async (client) => {
      const result = await call(client, "headscale_nodes", {
        action: "get_node",
        params: { nodeId: "not-a-number" },
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("numeric");
      expect(result.text).not.toContain("not-a-number");
      expect(calls).toHaveLength(0);
    });
  });

  it("maps 401, 404, 422, and 429 with Retry-After and drops stack paths", async () => {
    const cases: { status: number; body: unknown; needle: string; retry?: string }[] = [
      {
        status: 401,
        body: { code: 16, message: `unauthorized ${TOKEN}`, details: [{ stack: "/tmp/hs.go" }] },
        needle: "401",
      },
      {
        status: 404,
        body: { code: 5, message: "node not found /home/box/headscale.db", details: [] },
        needle: "404",
      },
      {
        status: 422,
        body: { code: 3, message: "policy is invalid", details: [{ stack: "/usr/src/app/x.ts" }] },
        needle: "422",
      },
      {
        status: 429,
        body: { message: "slow down" },
        needle: "429",
        retry: "12",
      },
    ];
    for (const testCase of cases) {
      const { fetchImpl } = jsonFetch(
        () =>
          new Response(JSON.stringify(testCase.body), {
            status: testCase.status,
            headers: {
              "content-type": "application/json",
              ...(testCase.retry === undefined ? {} : { "retry-after": testCase.retry }),
            },
          }),
      );
      await withClient(fetchImpl, {}, async (client) => {
        const result = await call(client, "headscale_nodes", { action: "list_nodes" });
        expect(result.isError).toBe(true);
        expect(result.text).toContain(testCase.needle);
        expect(result.text).not.toContain(TOKEN);
        expect(result.text).not.toContain("/tmp");
        expect(result.text).not.toContain("/home/box");
        expect(result.text).not.toContain("/usr/src");
        expect(result.text.toLowerCase()).not.toContain("stack");
        if (testCase.status === 429) {
          expect(result.text.toLowerCase()).toContain("rate");
          expect(result.text).toContain("Retry-After: 12s");
        }
        if (testCase.status === 401) expect(result.text).toContain("unauthorized");
        if (testCase.status === 404) expect(result.text).toContain("not found");
        if (testCase.status === 422) expect(result.text).toContain("invalid");
      });
    }
  });
});

describe("request shape", () => {
  it("sends Bearer auth and keeps the key out of the url", async () => {
    const seen: CapturedRequest[] = [];
    const { fetchImpl } = jsonFetch((captured) => {
      seen.push(captured);
      expectAuth(captured);
      return jsonResponse({ databaseConnectivity: true });
    });
    await withClient(fetchImpl, {}, async (client) => {
      const result = await call(client, "headscale_meta", { action: "health" });
      expect(result.isError).toBe(false);
      expect(result.json).toMatchObject({ databaseConnectivity: true });
      expect(seen[0]?.url).toBe(`${BASE}/api/v1/health`);
    });
  });
});

#!/usr/bin/env node
/**
 * Generate src/operations.ts from headscale.openapi.json (Swagger 2.0).
 * Run: node scripts/gen-operations.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const spec = JSON.parse(readFileSync(join(root, "headscale.openapi.json"), "utf8"));

const HTTP = new Set(["get", "post", "put", "patch", "delete"]);
const METHODS = ["get", "post", "put", "patch", "delete"];

const DEFAULT_TOOLSETS = ["nodes", "users", "policy", "meta"];

const WARN = {
  deleteNode:
    "This deletes a node and removes it from the tailnet.",
  expireNode: "This expires a node and disconnects it.",
  deleteUser: "This deletes a user and the nodes and keys that belong to that user.",
  deletePreAuth: "This deletes a pre-auth key.",
  expirePreAuth: "This expires a pre-auth key so it can no longer register nodes.",
  deleteApi:
    "This deletes an API key by prefix. Do not delete the key this connector is using.",
  expireApi:
    "This expires an API key by prefix. Do not expire the key this connector is using.",
  tags: "This changes node tags and can change which networks the node can reach.",
  routes: "This approves subnet routes and can expose those networks to the tailnet.",
  policy: "A bad policy can lock all nodes out of the tailnet.",
  preAuth:
    "This mints a pre-auth key. The secret is shown once in the confirmed response and redacted after that.",
  apiKey:
    "This mints an API key. The secret is shown once in the confirmed response and redacted after that.",
  register: "This registers a node and can admit a device onto the tailnet.",
  approve: "This approves a pending registration and admits a device onto the tailnet.",
  debug:
    "TEST ONLY. This inserts a node without a real Tailscale client. Do not enable the debug toolset on a production tailnet.",
  backfill: "This rewrites node IP assignments and can disrupt existing nodes.",
};

/** @type {Record<string, { summary: string, warnings: string[], reveal?: boolean, policy?: string }>} */
const META = {
  HeadscaleService_ListApiKeys: { summary: "List API keys. Secrets are not included. Prefixes and ids are." },
  HeadscaleService_CreateApiKey: {
    summary: "Mint an API key. The secret is returned once.",
    warnings: [WARN.apiKey],
    reveal: true,
  },
  HeadscaleService_ExpireApiKey: {
    summary: "Expire an API key by prefix.",
    warnings: [WARN.expireApi],
  },
  HeadscaleService_DeleteApiKey: {
    summary: "Delete an API key by prefix.",
    warnings: [WARN.deleteApi],
  },
  HeadscaleService_AuthApprove: {
    summary: "Approve a pending node registration.",
    warnings: [WARN.approve],
  },
  HeadscaleService_AuthRegister: {
    summary: "Attach a pending registration to a user.",
    warnings: [WARN.register],
  },
  HeadscaleService_AuthReject: { summary: "Reject a pending node registration." },
  HeadscaleService_DebugCreateNode: {
    summary: "TEST ONLY. Insert a node without a Tailscale client.",
    warnings: [WARN.debug],
  },
  HeadscaleService_Health: { summary: "Report database connectivity." },
  HeadscaleService_ListNodes: { summary: "List nodes. Node key material is redacted." },
  HeadscaleService_BackfillNodeIPs: {
    summary: "Backfill node IP addresses.",
    warnings: [WARN.backfill],
  },
  HeadscaleService_RegisterNode: {
    summary: "Register a node with a registration key.",
    warnings: [WARN.register],
  },
  HeadscaleService_GetNode: { summary: "Get one node. Node key material is redacted." },
  HeadscaleService_DeleteNode: { summary: "Delete a node.", warnings: [WARN.deleteNode] },
  HeadscaleService_SetApprovedRoutes: {
    summary: "Approve subnet routes for a node.",
    warnings: [WARN.routes],
  },
  HeadscaleService_ExpireNode: { summary: "Expire a node.", warnings: [WARN.expireNode] },
  HeadscaleService_RenameNode: { summary: "Rename a node." },
  HeadscaleService_SetTags: { summary: "Set tags on a node.", warnings: [WARN.tags] },
  HeadscaleService_GetPolicy: { summary: "Get the current policy." },
  HeadscaleService_SetPolicy: {
    summary: "Replace the tailnet policy.",
    warnings: [WARN.policy],
    policy: "set",
  },
  HeadscaleService_CheckPolicy: {
    summary: "Validate a policy. Headscale does not save it.",
    policy: "check",
  },
  HeadscaleService_ListPreAuthKeys: {
    summary: "List pre-auth keys. The key secret is redacted. The id is kept.",
  },
  HeadscaleService_DeletePreAuthKey: {
    summary: "Delete a pre-auth key by id.",
    warnings: [WARN.deletePreAuth],
  },
  HeadscaleService_CreatePreAuthKey: {
    summary: "Mint a pre-auth key. The secret is returned once.",
    warnings: [WARN.preAuth],
    reveal: true,
  },
  HeadscaleService_ExpirePreAuthKey: {
    summary: "Expire a pre-auth key by id.",
    warnings: [WARN.expirePreAuth],
  },
  HeadscaleService_ListUsers: { summary: "List users." },
  HeadscaleService_CreateUser: { summary: "Create a user." },
  HeadscaleService_DeleteUser: { summary: "Delete a user.", warnings: [WARN.deleteUser] },
  HeadscaleService_RenameUser: { summary: "Rename a user." },
};

/** @type {Record<string, unknown>} */
const BODIES = {
  HeadscaleService_CreateApiKey: { expiration: "2026-12-01T00:00:00.000Z" },
  HeadscaleService_ExpireApiKey: { prefix: "hsprefix" },
  HeadscaleService_AuthApprove: { authId: "auth-sample" },
  HeadscaleService_AuthRegister: { user: "sample-user", authId: "auth-sample" },
  HeadscaleService_AuthReject: { authId: "auth-sample" },
  HeadscaleService_DebugCreateNode: {
    user: "sample-user",
    key: "abcdefghijklmnopqrstuvwx",
    name: "sample-node",
    routes: ["10.0.0.0/24"],
  },
  HeadscaleService_SetApprovedRoutes: { routes: ["10.0.0.0/24"] },
  HeadscaleService_SetTags: { tags: ["tag:sample"] },
  HeadscaleService_SetPolicy: {
    policy: '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}',
  },
  HeadscaleService_CheckPolicy: {
    policy: '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}',
  },
  HeadscaleService_CreatePreAuthKey: { user: "1", reusable: false, ephemeral: false },
  HeadscaleService_ExpirePreAuthKey: { id: "1" },
  HeadscaleService_CreateUser: { name: "sample-user" },
};

const POLICY_SAMPLE = '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}';

/**
 * @param {string} operationId
 */
function actionFromOperationId(operationId) {
  const stripped = operationId.replace(/^HeadscaleService_/, "");
  const normalized = stripped.replace(/IPs(?![a-z])/g, "Ips").replace(/IDs(?![a-z])/g, "Ids");
  return normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * @param {string} path
 */
function toolsetFor(path) {
  if (path.startsWith("/api/v1/debug/")) return "debug";
  if (path.startsWith("/api/v1/node")) return "nodes";
  if (path.startsWith("/api/v1/user")) return "users";
  if (path.startsWith("/api/v1/preauthkey")) return "preauth_keys";
  if (path.startsWith("/api/v1/apikey")) return "api_keys";
  if (path.startsWith("/api/v1/policy")) return "policy";
  if (path.startsWith("/api/v1/auth/")) return "auth";
  if (path === "/api/v1/health") return "meta";
  throw new Error(`Unmapped Headscale path ${path}`);
}

/**
 * @param {string} name
 */
function sampleParam(name) {
  if (name === "nodeId" || name === "id" || name === "oldId") return "1";
  if (name === "newName") return "renamed-node";
  if (name === "prefix") return "hsprefix";
  if (name === "user") return "sample-user";
  if (name === "key") return "abcdefghijklmnopqrstuvwx";
  return "sample";
}

/**
 * @param {string} ref
 */
function resolveRef(ref) {
  if (!ref.startsWith("#/definitions/")) return undefined;
  const name = ref.slice("#/definitions/".length);
  const definitions = /** @type {Record<string, unknown>} */ (spec.definitions ?? {});
  const found = definitions[name];
  return found !== null && typeof found === "object" ? /** @type {Record<string, unknown>} */ (found) : undefined;
}

/**
 * @param {Record<string, unknown> | undefined} schema
 * @returns {string[]}
 */
function uintFields(schema) {
  if (schema === undefined) return [];
  const ref = schema["$ref"];
  if (typeof ref === "string") return uintFields(resolveRef(ref));
  const properties = schema["properties"];
  if (properties === null || typeof properties !== "object") return [];
  /** @type {string[]} */
  const names = [];
  for (const [name, value] of Object.entries(properties)) {
    if (value !== null && typeof value === "object" && /** @type {Record<string, unknown>} */ (value)["format"] === "uint64") {
      names.push(name);
    }
  }
  return names;
}

/**
 * @param {string} operationId
 * @param {string} method
 */
function isWrite(operationId, method) {
  if (method === "GET") return false;
  if (operationId === "HeadscaleService_CheckPolicy") return false;
  return true;
}

/**
 * @param {string} operationId
 * @param {string} method
 * @param {readonly string[]} warnings
 */
function isDestructive(operationId, method, warnings) {
  if (method === "DELETE") return true;
  if (operationId.includes("Expire")) return true;
  return warnings.length > 0 && operationId !== "HeadscaleService_BackfillNodeIPs";
}

/** @type {object[]} */
const rows = [];

const paths = /** @type {Record<string, Record<string, unknown>>} */ (spec.paths ?? {});
for (const [path, item] of Object.entries(paths)) {
  for (const method of METHODS) {
    const op = item[method];
    if (op === undefined || !HTTP.has(method) || op === null || typeof op !== "object") continue;
    const operation = /** @type {Record<string, unknown>} */ (op);
    const operationId = String(operation["operationId"] ?? "");
    if (!operationId.startsWith("HeadscaleService_")) {
      throw new Error(`Unexpected operationId ${operationId} on ${method} ${path}`);
    }
    const meta = META[operationId];
    if (meta === undefined) throw new Error(`No metadata for ${operationId}`);
    const toolset = toolsetFor(path);
    const action = actionFromOperationId(operationId);
    const upper = method.toUpperCase();
    const parameters = Array.isArray(operation["parameters"]) ? operation["parameters"] : [];
    /** @type {string[]} */
    const pathParams = [];
    /** @type {string[]} */
    const queryParams = [];
    /** @type {string[]} */
    const numericPath = [];
    /** @type {string[]} */
    const numericQuery = [];
    /** @type {string[]} */
    const numericBody = [];
    /** @type {Record<string, string>} */
    const sampleParams = {};
    /** @type {Record<string, string>} */
    const sampleQuery = {};
    let sampleBody = BODIES[operationId];

    for (const parameter of parameters) {
      if (parameter === null || typeof parameter !== "object") continue;
      const param = /** @type {Record<string, unknown>} */ (parameter);
      const name = String(param["name"] ?? "");
      const where = String(param["in"] ?? "");
      if (where === "path") {
        pathParams.push(name);
        sampleParams[name] = sampleParam(name);
        if (name === "nodeId" || name === "oldId" || (name === "id" && path.includes("/user/"))) {
          numericPath.push(name);
        }
      } else if (where === "query") {
        queryParams.push(name);
        if (name === "id" || param["format"] === "uint64") numericQuery.push(name);
        const required = param["required"] === true;
        const register = operationId === "HeadscaleService_RegisterNode" && (name === "user" || name === "key");
        if (required || name === "id" || register) sampleQuery[name] = sampleParam(name);
      } else if (where === "body") {
        const schema = param["schema"];
        const fields = uintFields(
          schema !== null && typeof schema === "object" ? /** @type {Record<string, unknown>} */ (schema) : undefined,
        );
        for (const field of fields) {
          if (!numericBody.includes(field)) numericBody.push(field);
        }
      }
    }

    const warnings = meta.warnings ?? [];
    rows.push({
      method: upper,
      path,
      tool: `headscale_${toolset}`,
      action,
      toolset,
      operationId,
      write: isWrite(operationId, upper),
      destructive: isDestructive(operationId, upper, warnings),
      revealSecret: meta.reveal === true,
      virtual: false,
      policy: meta.policy ?? "none",
      summary: meta.summary,
      pathParams,
      queryParams,
      numericPath,
      numericQuery,
      numericBody,
      warnings,
      sampleParams,
      sampleQuery,
      sampleBody,
    });
  }
}

rows.push({
  method: "GET",
  path: "/api/v1/policy",
  tool: "headscale_policy",
  action: "diff",
  toolset: "policy",
  operationId: "virtual_diff",
  write: false,
  destructive: false,
  revealSecret: false,
  virtual: true,
  policy: "diff",
  summary: "Compare a proposed policy with the saved policy. Sends only the policy read.",
  pathParams: [],
  queryParams: [],
  numericPath: [],
  numericQuery: [],
  numericBody: [],
  warnings: [],
  sampleParams: {},
  sampleQuery: {},
  sampleBody: { policy: POLICY_SAMPLE },
});

rows.sort((a, b) => {
  const tool = String(a.tool).localeCompare(String(b.tool));
  if (tool !== 0) return tool;
  return String(a.action).localeCompare(String(b.action));
});

const toolsets = [...new Set(rows.map((row) => String(row.toolset)))].sort();
for (const name of DEFAULT_TOOLSETS) {
  if (!toolsets.includes(name)) throw new Error(`Default toolset ${name} is not generated`);
}

/** @type {Record<string, { operations: number, actions: string[] }>} */
const counts = {};
for (const row of rows) {
  const toolset = String(row.toolset);
  const bucket = counts[toolset] ?? { operations: 0, actions: [] };
  bucket.operations += 1;
  bucket.actions.push(String(row.action));
  counts[toolset] = bucket;
}

/**
 * @param {unknown} value
 */
function emit(value) {
  return JSON.stringify(value);
}

const lines = rows.map((row) => {
  const body =
    row.sampleBody === undefined ? "" : `\n    sampleBody: ${emit(row.sampleBody)},`;
  return `  row(${emit(row.method)}, ${emit(row.path)}, ${emit(row.tool)}, {
    action: ${emit(row.action)},
    toolset: ${emit(row.toolset)},
    operationId: ${emit(row.operationId)},
    write: ${row.write ? "true" : "false"},
    destructive: ${row.destructive ? "true" : "false"},
    revealSecret: ${row.revealSecret ? "true" : "false"},
    virtual: ${row.virtual ? "true" : "false"},
    policy: ${emit(row.policy)},
    summary: ${emit(row.summary)},
    pathParams: ${emit(row.pathParams)},
    queryParams: ${emit(row.queryParams)},
    numericPath: ${emit(row.numericPath)},
    numericQuery: ${emit(row.numericQuery)},
    numericBody: ${emit(row.numericBody)},
    warnings: ${emit(row.warnings)},
    sampleParams: ${emit(row.sampleParams)},
    sampleQuery: ${emit(row.sampleQuery)},${body}
  }),`;
});

const source = `/** Generated by scripts/gen-operations.mjs from headscale.openapi.json. Do not edit by hand. */

import { ConnectorError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type PolicyMode = "none" | "check" | "diff" | "set";

export interface Operation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly tool: string;
  readonly action: string;
  readonly toolset: string;
  readonly operationId: string;
  readonly write: boolean;
  readonly destructive: boolean;
  readonly revealSecret: boolean;
  readonly virtual: boolean;
  readonly policy: PolicyMode;
  readonly summary: string;
  readonly pathParams: readonly string[];
  readonly queryParams: readonly string[];
  readonly numericPath: readonly string[];
  readonly numericQuery: readonly string[];
  readonly numericBody: readonly string[];
  readonly warnings: readonly string[];
  readonly sampleParams: Readonly<Record<string, string>>;
  readonly sampleQuery: Readonly<Record<string, string>>;
  readonly sampleBody: unknown;
}

function row(
  method: HttpMethod,
  path: string,
  tool: string,
  options: {
    action: string;
    toolset: string;
    operationId: string;
    write: boolean;
    destructive: boolean;
    revealSecret: boolean;
    virtual: boolean;
    policy: PolicyMode;
    summary: string;
    pathParams: readonly string[];
    queryParams: readonly string[];
    numericPath: readonly string[];
    numericQuery: readonly string[];
    numericBody: readonly string[];
    warnings: readonly string[];
    sampleParams: Readonly<Record<string, string>>;
    sampleQuery: Readonly<Record<string, string>>;
    sampleBody?: unknown;
  },
): Operation {
  return {
    method,
    path,
    tool,
    action: options.action,
    toolset: options.toolset,
    operationId: options.operationId,
    write: options.write,
    destructive: options.destructive,
    revealSecret: options.revealSecret,
    virtual: options.virtual,
    policy: options.policy,
    summary: options.summary,
    pathParams: options.pathParams,
    queryParams: options.queryParams,
    numericPath: options.numericPath,
    numericQuery: options.numericQuery,
    numericBody: options.numericBody,
    warnings: options.warnings,
    sampleParams: options.sampleParams,
    sampleQuery: options.sampleQuery,
    sampleBody: options.sampleBody,
  };
}

export const DEFAULT_TOOLSETS = ${emit(DEFAULT_TOOLSETS)} as const;

export const ALL_TOOLSETS = ${emit(toolsets)} as const;

export const TOOLSET_COUNTS: Readonly<
  Record<string, { readonly operations: number; readonly actions: readonly string[] }>
> = ${emit(counts)};

export const OPERATIONS: readonly Operation[] = [
${lines.join("\n")}
];

export function toolNames(): string[] {
  return [...new Set(OPERATIONS.map((operation) => operation.tool))].sort();
}

export function operationsForTool(name: string): Operation[] {
  return OPERATIONS.filter((operation) => operation.tool === name);
}

export function toolIsWrite(name: string): boolean {
  return OPERATIONS.some((operation) => operation.tool === name && operation.write);
}

export function openApiKeys(): string[] {
  return OPERATIONS.filter((operation) => !operation.virtual)
    .map((operation) => \`\${operation.method} \${operation.path}\`)
    .sort();
}

export function requireOp(tool: string, action: string): Operation {
  const found = OPERATIONS.find((operation) => operation.tool === tool && operation.action === action);
  if (found === undefined) {
    throw new ConnectorError("input", \`Unknown Headscale operation \${tool} \${action}.\`);
  }
  return found;
}

export function parseToolsets(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_TOOLSETS];
  const trimmed = raw.trim();
  if (trimmed === "all") return [...ALL_TOOLSETS];
  const wanted = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const allowed = new Set<string>(ALL_TOOLSETS);
  const unknown = wanted.filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new ConnectorError("config", "Unknown HEADSCALE_TOOLSETS value.");
  }
  return [...new Set(wanted)];
}

export function toolsForToolsets(enabled: readonly string[]): string[] {
  const allow = new Set(enabled);
  return toolNames().filter((name) => {
    const operation = OPERATIONS.find((row) => row.tool === name);
    return operation !== undefined && allow.has(operation.toolset);
  });
}
`;

const target = join(root, "src", "operations.ts");
writeFileSync(target, source);
execFileSync("npx", ["prettier", "--write", target], { cwd: root, stdio: "inherit" });

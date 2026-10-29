import { z } from "zod";
import type { QueryMap } from "./http.js";
import { definedQuery, fillHeadscalePath } from "./json.js";
import type { Operation } from "./operations.js";
import { requireOp } from "./operations.js";
import { asRecord, parseHealth, policyFromBody, policyText } from "./parse.js";
import { diffPolicy, type PolicyDiff } from "./policy-diff.js";
import { ConnectorError } from "./errors.js";
import type { Runtime } from "./runtime.js";
import { withWrite } from "./write-gate.js";

const jsonValueSchema = z.unknown();

export interface CallArgs {
  readonly params?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly query?: Readonly<Record<string, string | number | boolean>> | undefined;
  readonly body?: unknown;
  readonly confirm?: true | undefined;
}

function asQuery(
  record: Readonly<Record<string, string | number | boolean>> | undefined,
): QueryMap | undefined {
  if (record === undefined) return undefined;
  const mapped: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(record)) mapped[key] = value;
  return definedQuery(mapped);
}

function asParams(
  record: Readonly<Record<string, string | number | boolean>> | undefined,
): Record<string, string | number> {
  if (record === undefined) return {};
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "boolean") out[key] = String(value);
    else out[key] = value;
  }
  return out;
}

function assertUint(label: string, value: string): void {
  if (!/^[0-9]+$/.test(value)) {
    throw new ConnectorError("input", `Invalid ${label}. Expected a numeric string.`);
  }
}

function assertNumeric(operation: Operation, args: CallArgs): void {
  const params = args.params ?? {};
  for (const name of operation.numericPath) {
    const value = params[name];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new ConnectorError("input", `Invalid ${name}. Send the id as a numeric string.`);
    }
    assertUint(name, value);
  }
  const query = args.query ?? {};
  for (const name of operation.numericQuery) {
    const value = query[name];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new ConnectorError("input", `Invalid ${name}. Send the id as a numeric string.`);
    }
    assertUint(name, value);
  }
  if (operation.numericBody.length === 0 || args.body === undefined) return;
  if (typeof args.body !== "object" || args.body === null || Array.isArray(args.body)) {
    throw new ConnectorError("input", "Request body must be an object.");
  }
  const body = asRecord(args.body);
  for (const name of operation.numericBody) {
    const value = body[name];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new ConnectorError("input", `Invalid ${name}. Send the id as a numeric string.`);
    }
    assertUint(name, value);
  }
}

function unwrapBody(body: unknown): Record<string, unknown> {
  return asRecord(body);
}

export async function callHeadscale(
  runtime: Runtime,
  operation: Operation,
  args: CallArgs = {},
): Promise<Record<string, unknown>> {
  assertNumeric(operation, args);
  if (operation.policy === "diff") return diffAgainstCurrent(runtime, args);
  if (operation.policy === "set" && args.confirm === true) {
    if (policyFromBody(args.body).trim() === "") {
      throw new ConnectorError("input", "Refusing to set an empty policy.");
    }
  }

  const rawParams = asParams(args.params);
  const prefixValue = rawParams["prefix"];
  const params =
    typeof prefixValue === "string"
      ? { ...rawParams, prefix: prefixValue.replace(/\*+$/, "") }
      : rawParams;
  const path = fillHeadscalePath(operation.path, params);
  const query = asQuery(args.query);
  const run = async (): Promise<Record<string, unknown>> => execute(runtime, operation, path, query, args);

  if (!operation.write) return run();

  let policyDiff: PolicyDiff | { error: string } | undefined;
  const previewing = args.confirm !== true || !runtime.config.allowWrites;
  if (operation.policy === "set" && previewing) {
    policyDiff = await safePolicyDiff(runtime, policyFromBody(args.body));
  }

  const gated = await withWrite(
    runtime,
    args.confirm,
    {
      method: operation.method,
      path,
      query,
      body: args.body,
      summary: operation.summary,
      warnings: operation.warnings,
      revealSecret: operation.revealSecret,
    },
    run,
  );
  if (gated["dry_run"] === true && policyDiff !== undefined) {
    return { ...gated, diff: policyDiff };
  }
  return gated;
}

async function diffAgainstCurrent(runtime: Runtime, args: CallArgs): Promise<Record<string, unknown>> {
  const proposed = policyFromBody(args.body);
  const diff = await safePolicyDiff(runtime, proposed);
  return {
    executed: false,
    dry_run: false,
    sent: "GET /api/v1/policy",
    diff,
  };
}

async function safePolicyDiff(
  runtime: Runtime,
  proposed: string,
): Promise<PolicyDiff | { error: string }> {
  try {
    const current = await fetchPolicy(runtime);
    return diffPolicy(current, proposed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "policy read failed";
    return { error: message };
  }
}

async function fetchPolicy(runtime: Runtime): Promise<string> {
  const operation = requireOp("headscale_policy", "get_policy");
  const path = fillHeadscalePath(operation.path, {});
  try {
    const result = await execute(runtime, operation, path, undefined, {});
    return policyText(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/acl policy not found/i.test(message)) return "";
    throw error;
  }
}

async function execute(
  runtime: Runtime,
  operation: Operation,
  path: string,
  query: QueryMap | undefined,
  args: CallArgs,
): Promise<Record<string, unknown>> {
  const fieldRedact = !operation.revealSecret;
  const ttlSec = operation.write ? 0 : runtime.cacheTtlSec;
  if (operation.method === "GET") {
    const json = await runtime.client.getJson({ path, query, ttlSec }, jsonValueSchema);
    const body = unwrapBody(json);
    if (operation.action === "health") parseHealth(body);
    return body;
  }
  if (args.body === undefined) {
    const sent =
      operation.method === "PUT"
        ? await runtime.client.putEmpty({ path, query, fieldRedact })
        : operation.method === "DELETE"
          ? await runtime.client.delete({ path, query, fieldRedact })
          : await runtime.client.postEmpty({ path, query, fieldRedact });
    return unwrapBody(sent.body);
  }
  if (operation.method === "POST") {
    const json = await runtime.client.postJson(
      { path, query, body: args.body, fieldRedact },
      jsonValueSchema,
    );
    return unwrapBody(json);
  }
  if (operation.method === "PUT") {
    const json = await runtime.client.putJson(
      { path, query, body: args.body, fieldRedact },
      jsonValueSchema,
    );
    return unwrapBody(json);
  }
  const json = await runtime.client.deleteJson(
    { path, query, body: args.body, fieldRedact },
    jsonValueSchema,
  );
  return unwrapBody(json);
}

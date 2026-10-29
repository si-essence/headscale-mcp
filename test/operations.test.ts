import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ALL_TOOLSETS,
  DEFAULT_TOOLSETS,
  OPERATIONS,
  openApiKeys,
  parseToolsets,
  toolNames,
  toolsForToolsets,
} from "../src/operations.js";

const HTTP = ["get", "post", "put", "patch", "delete"];

describe("spec coverage", () => {
  it("matches headscale.openapi.json in both directions", () => {
    const spec = JSON.parse(
      readFileSync(new URL("../headscale.openapi.json", import.meta.url), "utf8"),
    ) as {
      paths: Record<string, Record<string, { operationId?: string }>>;
    };
    const specKeys: string[] = [];
    const specIds: string[] = [];
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const method of Object.keys(ops)) {
        if (!HTTP.includes(method)) continue;
        specKeys.push(`${method.toUpperCase()} ${path}`);
        const operationId = ops[method]?.operationId;
        if (operationId !== undefined) specIds.push(operationId);
      }
    }
    specKeys.sort();
    specIds.sort();
    const registry = OPERATIONS.filter((operation) => !operation.virtual);
    const registryKeys = registry.map((operation) => `${operation.method} ${operation.path}`).sort();
    const registryIds = registry.map((operation) => operation.operationId).sort();
    expect(openApiKeys()).toEqual(specKeys);
    expect(registryKeys).toEqual(specKeys);
    expect(registryIds).toEqual(specIds);
    expect(specKeys).toHaveLength(29);
    expect(registry).toHaveLength(29);
    const virtual = OPERATIONS.filter((operation) => operation.virtual);
    expect(virtual.map((operation) => operation.action)).toEqual(["diff"]);
    expect(OPERATIONS).toHaveLength(30);
    expect(toolNames()).toHaveLength(ALL_TOOLSETS.length);
    expect(DEFAULT_TOOLSETS).toEqual(["nodes", "users", "policy", "meta"]);
    const actions = OPERATIONS.map((row) => `${row.tool}::${row.action}`);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it("keeps reads ungated, including policy check, and gates every other non-GET", () => {
    const check = OPERATIONS.find((operation) => operation.action === "check_policy");
    expect(check?.write).toBe(false);
    expect(check?.method).toBe("POST");
    const reads = OPERATIONS.filter((operation) => !operation.write);
    expect(reads.every((operation) => operation.method === "GET" || operation.action === "check_policy" || operation.action === "diff")).toBe(
      true,
    );
    const writes = OPERATIONS.filter((operation) => operation.write);
    expect(writes.every((operation) => operation.method !== "GET")).toBe(true);
    expect(writes.map((operation) => operation.action)).toContain("set_policy");
  });
});

describe("toolset scoping", () => {
  it("defaults to the read-focused subset and treats all as every toolset", () => {
    expect(parseToolsets(undefined)).toEqual([...DEFAULT_TOOLSETS]);
    expect(parseToolsets("all")).toEqual([...ALL_TOOLSETS]);
    expect(toolsForToolsets(parseToolsets(undefined))).toEqual([
      "headscale_meta",
      "headscale_nodes",
      "headscale_policy",
      "headscale_users",
    ]);
    expect(toolsForToolsets(parseToolsets("all"))).toEqual(toolNames());
    expect(parseToolsets("debug")).toEqual(["debug"]);
    expect(toolsForToolsets(["debug"])).toEqual(["headscale_debug"]);
    expect(toolsForToolsets(parseToolsets(undefined))).not.toContain("headscale_debug");
  });
});

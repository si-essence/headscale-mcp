import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { runtimeFor, jsonResponse } from "./harness.js";
import { connectServer } from "./mcp.js";

describe("server", () => {
  it("publishes the default toolsets and answers health over the MCP client", async () => {
    const runtime = runtimeFor(() => Promise.resolve(jsonResponse({ databaseConnectivity: true })), {
      HEADSCALE_TOOLSETS: undefined,
      HEADSCALE_ALLOW_WRITES: "false",
    });
    const server = createServer(runtime);
    expect(server).toBeDefined();
    const { client, close } = await connectServer(runtime);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "headscale_meta",
        "headscale_nodes",
        "headscale_policy",
        "headscale_users",
      ]);
    } finally {
      await close();
    }
  });
});

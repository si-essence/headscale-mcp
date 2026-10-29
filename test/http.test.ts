import { describe, expect, it } from "vitest";
import { ConnectorError } from "../src/errors.js";
import { z } from "zod";
import { runtimeFor, TOKEN, jsonResponse } from "./harness.js";

const schema = z.unknown();

describe("HttpClient", () => {
  it("sends a bearer token and does not put it in the url", async () => {
    const runtime = runtimeFor((input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      expect(url).not.toContain(TOKEN);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
      return Promise.resolve(jsonResponse({ databaseConnectivity: true }));
    });
    const body = await runtime.client.getJson(
      { path: "api/v1/health", query: undefined, ttlSec: 0 },
      schema,
    );
    expect(body).toMatchObject({ databaseConnectivity: true });
  });

  it("maps a timeout to the timeout code", async () => {
    const runtime = runtimeFor(() => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      return Promise.reject(error);
    }, { HEADSCALE_TIMEOUT_MS: "1000" });
    await expect(
      runtime.client.getJson({ path: "api/v1/health", query: undefined, ttlSec: 0 }, schema),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("maps a network failure without echoing the key", async () => {
    const runtime = runtimeFor(() => Promise.reject(new Error(`connect ${TOKEN}`)));
    try {
      await runtime.client.getJson({ path: "api/v1/health", query: undefined, ttlSec: 0 }, schema);
      throw new Error("expected network error");
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      if (!(error instanceof ConnectorError)) throw error;
      expect(error.code).toBe("network");
      expect(error.message).not.toContain(TOKEN);
    }
  });

  it("refuses a response larger than the cap", async () => {
    const runtime = runtimeFor(
      () =>
        Promise.resolve(
          new Response("{}", {
            status: 200,
            headers: { "content-type": "application/json", "content-length": "2000000" },
          }),
        ),
    );
    await expect(
      runtime.client.getJson({ path: "api/v1/health", query: undefined, ttlSec: 0 }, schema),
    ).rejects.toMatchObject({ code: "upstream" });
  });
});

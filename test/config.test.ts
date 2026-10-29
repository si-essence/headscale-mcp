import { describe, expect, it } from "vitest";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { DEFAULT_TOOLSETS } from "../src/operations.js";

const KEY = "super-secret/key+value=99";
const URL = "http://127.0.0.1:8080";

function messageOf(error: unknown): string {
  expect(error).toBeInstanceOf(ConnectorError);
  if (!(error instanceof ConnectorError)) throw error;
  return error.message;
}

function catchError(run: () => unknown): unknown {
  try {
    return run();
  } catch (error) {
    return error;
  }
}

describe("loadConfig", () => {
  it("requires HEADSCALE_URL", () => {
    const message = messageOf(catchError(() => loadConfig({}, [])));
    expect(message).toContain("HEADSCALE_URL");
    expect(message).toContain("required");
  });

  it("applies defaults when the URL is set", () => {
    const config = loadConfig({ HEADSCALE_URL: URL }, []);
    expect(config.apiKey).toBeUndefined();
    expect(config.baseUrl).toBe(URL);
    expect(config.allowWrites).toBe(false);
    expect(config.toolsets).toEqual([...DEFAULT_TOOLSETS]);
    expect(config.perMinute).toBe(30);
    expect(config.timeoutMs).toBe(20_000);
    expect(config.contact).toBe("contact@example.com");
    expect(config.transport).toBe("stdio");
    expect(config.port).toBe(3000);
    expect(config.cacheTtlSec).toBe(60);
    expect(config.userAgent).toBe(`${CONNECTOR_NAME}/${CONNECTOR_VERSION} (contact@example.com)`);
  });

  it("lets --http override the transport", () => {
    expect(
      loadConfig({ HEADSCALE_URL: URL, MCP_TRANSPORT: "stdio" }, ["node", "app", "--http"]).transport,
    ).toBe("http");
    expect(loadConfig({ HEADSCALE_URL: URL, MCP_TRANSPORT: "http" }, []).transport).toBe("http");
  });

  it("strips a trailing /api/v1 from the base url", () => {
    const config = loadConfig({ HEADSCALE_URL: "http://127.0.0.1:8080/api/v1/" }, []);
    expect(config.baseUrl).toBe("http://127.0.0.1:8080");
  });

  it("enables writes only when HEADSCALE_ALLOW_WRITES is the literal true", () => {
    expect(loadConfig({ HEADSCALE_URL: URL, HEADSCALE_ALLOW_WRITES: "true" }, []).allowWrites).toBe(
      true,
    );
    expect(loadConfig({ HEADSCALE_URL: URL, HEADSCALE_ALLOW_WRITES: "yes" }, []).allowWrites).toBe(
      false,
    );
    expect(loadConfig({ HEADSCALE_URL: URL, HEADSCALE_ALLOW_WRITES: "TRUE" }, []).allowWrites).toBe(
      false,
    );
  });

  it("parses HEADSCALE_TOOLSETS", () => {
    expect(loadConfig({ HEADSCALE_URL: URL, HEADSCALE_TOOLSETS: "nodes,meta" }, []).toolsets).toEqual(
      ["nodes", "meta"],
    );
    expect(loadConfig({ HEADSCALE_URL: URL, HEADSCALE_TOOLSETS: "all" }, []).toolsets).toContain(
      "debug",
    );
    expect(loadConfig({ HEADSCALE_URL: URL }, []).toolsets).not.toContain("debug");
  });

  it("rejects an unknown toolset without echoing it", () => {
    const message = messageOf(
      catchError(() => loadConfig({ HEADSCALE_URL: URL, HEADSCALE_TOOLSETS: "nope" }, [])),
    );
    expect(message).toContain("HEADSCALE_TOOLSETS");
    expect(message).not.toContain("nope");
  });

  it("refuses Tailscale hosted domains", () => {
    for (const host of [
      "https://tailscale.com",
      "https://login.tailscale.com",
      "https://api.tailscale.com/api/v1",
      "https://tailscale.io",
      "https://controlplane.tailscale.io",
    ]) {
      const message = messageOf(catchError(() => loadConfig({ HEADSCALE_URL: host }, [])));
      expect(message).toContain("hosted_vendor");
      expect(message).toContain("self-hosted");
      expect(message).not.toContain("login.tailscale.com");
    }
  });

  it("allows a name that merely contains the vendor word", () => {
    const config = loadConfig({ HEADSCALE_URL: "https://nottailscale.com" }, []);
    expect(config.baseUrl).toBe("https://nottailscale.com");
  });

  it("reports invalid fields without the rejected value or the api key", () => {
    const message = messageOf(
      catchError(() =>
        loadConfig(
          { HEADSCALE_URL: URL, HEADSCALE_API_KEY: KEY, PORT: "nope", MCP_TRANSPORT: "sse" },
          [],
        ),
      ),
    );
    expect(message).toContain("PORT");
    expect(message).toContain("MCP_TRANSPORT");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("nope");
    expect(message).not.toContain("sse");
  });

  it("rejects a short api key without echoing it", () => {
    const message = messageOf(
      catchError(() => loadConfig({ HEADSCALE_URL: URL, HEADSCALE_API_KEY: "short" }, [])),
    );
    expect(message).toContain("HEADSCALE_API_KEY");
    expect(message).not.toContain("short");
  });

  it("rejects a base url or contact that contains the api key", () => {
    const inUrl = messageOf(
      catchError(() =>
        loadConfig({ HEADSCALE_API_KEY: KEY, HEADSCALE_URL: `https://headscale.test/${KEY}` }, []),
      ),
    );
    expect(inUrl).toContain("contains_secret");
    expect(inUrl).not.toContain(KEY);

    const inContact = messageOf(
      catchError(() =>
        loadConfig({ HEADSCALE_URL: URL, HEADSCALE_API_KEY: KEY, HEADSCALE_CONTACT: KEY }, []),
      ),
    );
    expect(inContact).toContain("HEADSCALE_CONTACT");
    expect(inContact).not.toContain(KEY);
  });

  it("rejects userinfo and query strings", () => {
    expect(messageOf(catchError(() => loadConfig({ HEADSCALE_URL: "https://user:pass@headscale.test" }, [])))).toContain(
      "userinfo",
    );
    expect(
      messageOf(catchError(() => loadConfig({ HEADSCALE_URL: `https://headscale.test/v1?api_key=${KEY}` }, []))),
    ).toContain("query_or_hash");
  });
});

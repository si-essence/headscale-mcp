# headscale-mcp (Headscale MCP connector)

MCP connector for a self-hosted [Headscale](https://github.com/juanfont/headscale) control server. It speaks the Headscale HTTP API over stdio and over stateless Streamable HTTP on localhost.

Headscale is BSD-3-Clause software. This connector is an independent HTTP client of that API. It is not affiliated with the Headscale project or with Tailscale. Bring your own API key from the server you run.

This connector covers all 29 operations in `headscale.openapi.json` (Headscale v0.29.6) plus one virtual policy diff. Operations are grouped into 8 toolsets. Enable a subset with `HEADSCALE_TOOLSETS` so the model only sees the tools you need.

Self-hosted Headscale only. There is no default base URL. `HEADSCALE_URL` is required and must be your server origin, for example `http://127.0.0.1:8080`. A trailing `/api/v1` is stripped. Calls go to `{HEADSCALE_URL}/api/v1`. Hosts on `tailscale.com` and `tailscale.io` are refused. This connector does not speak the Tailscale SaaS API.

## Setup

```bash
npm install
npm run ci
npm start
npm run start:http
```

`npm start` speaks stdio. `npm run start:http` serves Streamable HTTP at `http://127.0.0.1:3000/mcp` and `GET /health`. HTTP mode has no authentication. Keep it on localhost.

Create an API key with `headscale apikeys create`. The connector sends it as `Authorization: Bearer` and never prints it.

```json
{
  "mcpServers": {
    "headscale": {
      "command": "node",
      "args": ["/workspace/connectors/headscale/dist/index.js"],
      "env": {
        "HEADSCALE_URL": "http://127.0.0.1:8080",
        "HEADSCALE_API_KEY": "...",
        "HEADSCALE_ALLOW_WRITES": "false",
        "HEADSCALE_TOOLSETS": "nodes,users,policy,meta",
        "HEADSCALE_CONTACT": "you@example.com"
      }
    }
  }
}
```

Docker (HTTP, no authentication, localhost only):

```bash
docker build -t headscale-mcp .
docker run -p 3000:3000 \
  -e HEADSCALE_URL=http://host.docker.internal:8080 \
  -e HEADSCALE_API_KEY=... \
  headscale-mcp
```

Do not put the API key in the image.

Regenerate the operations registry after a Swagger bump:

```bash
npm run gen:operations
```

`src/operations.ts` is generated. Do not edit it by hand.

## Config

| Variable | Meaning |
| --- | --- |
| `HEADSCALE_URL` | Required. Self-hosted Headscale origin. `/api/v1` is stripped if present. Tailscale hosts are refused. |
| `HEADSCALE_API_KEY` | API key. Sent as `Authorization: Bearer`. Always redacted in output. |
| `HEADSCALE_ALLOW_WRITES` | Must be the literal `true` before a confirmed write is sent. |
| `HEADSCALE_TOOLSETS` | Comma list of toolsets, or `all`. Default `nodes,users,policy,meta`. |
| `HEADSCALE_PER_MINUTE` | Local request budget. Default 30. |
| `HEADSCALE_TIMEOUT_MS` | Upstream timeout. Default 20000. |
| `HEADSCALE_CACHE_TTL_SEC` | GET cache TTL. Default 60. Writes clear the cache. |
| `HEADSCALE_CONTACT` | Contact token in the User-Agent. Must not be the API key. |
| `MCP_TRANSPORT` | `stdio` or `http`. `--http` overrides. |
| `PORT` | HTTP port. Default 3000. |

## Safety

Reads run without `confirm`. `check_policy` is a read. Headscale validates the policy in a sandbox and does not save it. `diff` only GETs the current policy.

Every other non-GET is a write. A write needs `confirm: true` (a boolean, not the string `"true"`) and `HEADSCALE_ALLOW_WRITES=true`. Otherwise the tool returns a dry-run preview of the method, path, query, and redacted body, and it sends no write. `set_policy` is the exception on the read side of a preview. Its preview GETs the current policy so the preview can include a line diff. It still does not PUT until both gates pass. A confirmed `set_policy` with an empty policy string is refused before any request.

Preview and tool descriptions warn on node delete and expire, user delete, pre-auth key create, delete, and expire, API key create, delete, and expire, node tags, approved routes, policy set (a bad policy can lock all nodes out), node register, auth approve, and the debug node creator.

Creating a pre-auth key or an API key returns the secret once, with a note that it is shown only once. List and get responses, and every preview, keep the id or prefix and mask the secret. The caller's own `HEADSCALE_API_KEY` is redacted everywhere, including inside that one-time response.

Node ids and user ids stay strings and must be numeric. The spec has no pagination parameters.

Errors use a stable prefix. `[unauthorized]` is 401. `[forbidden]` is 403. `[not-found]` is 404. `[invalid]` is 400 or 422. `[rate-limit]` is 429 and includes Retry-After. Server errors, network errors, and timeouts have their own codes. Stack traces and filesystem paths are stripped. Responses larger than 1 MB are rejected.

## Tools

Default `HEADSCALE_TOOLSETS` publishes 4 tools. `HEADSCALE_TOOLSETS=all` publishes 8 tools (30 actions). Each tool takes `action` plus `params`, `query`, `body`, and `confirm` when the tool has writes.

| Toolset | Tool | Actions | Default |
| --- | --- | --- | --- |
| nodes | `headscale_nodes` | 9 | yes |
| users | `headscale_users` | 4 | yes |
| policy | `headscale_policy` | 4 | yes |
| meta | `headscale_meta` | 1 | yes |
| preauth_keys | `headscale_preauth_keys` | 4 | no |
| api_keys | `headscale_api_keys` | 4 | no |
| auth | `headscale_auth` | 3 | no |
| debug | `headscale_debug` | 1 | no |

`debug` is only enabled by `all`. `debug_create_node` inserts a node without a real client. It is for tests. The tool description says so.

Policy actions are `get_policy`, `check_policy`, `diff`, and `set_policy`. `diff` takes a proposed HuJSON or JSON policy string and returns added and removed line counts plus a compact line diff.

Example. List users, preview a create, then confirm it:

```json
{ "action": "list_users" }
```

```json
{ "action": "create_user", "body": { "name": "lab" } }
```

```json
{ "action": "create_user", "body": { "name": "lab" }, "confirm": true }
```

## Live check

`npm run live-check` talks to a real Headscale when `HEADSCALE_URL` and `HEADSCALE_API_KEY` are set. It creates throwaway users, keys, and a debug node, checks previews first, then deletes them. It reads policy, checks and diffs a permissive policy, sets that policy, and restores the previous policy. If the previous policy was empty, it writes the same permissive default back. If those variables are unset, it prints a skip message and exits 0. It prints pass and fail lines only.

`LIVE-CHECK.md` says what the script covers. This session did not run it against a server.

## What this is not

This is not a Tailscale.com or Tailscale SaaS client. Those hosts are rejected.

This is not a WireGuard or Tailscale node. It does not join a tailnet, ship DERP, or install `tailscaled`.

This is not a full replacement for the `headscale` CLI install path. Server bootstrap, config files, and database migrations stay on the host.

`debug_create_node` is not a supported way to enroll production devices. Use register or a pre-auth key for that, and treat the debug tool as test-only.

Compared with a small community server that exposes about 17 tools and no ACL actions, this connector covers the v0.29.6 Swagger, gates writes, and adds policy get, check, diff, and set.

## Attribution

Headscale is BSD-3-Clause. This connector does not copy Headscale source. It calls the HTTP API described by the Swagger file in this repo.

## License

MIT, see [LICENSE](LICENSE). This is an independent, unofficial connector and is not endorsed by the Headscale project or its owners.

headscale.openapi.json is generated from juanfont/headscale (BSD-3-Clause, Copyright (c) 2020, Juan Font).

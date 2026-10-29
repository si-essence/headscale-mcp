# Live check against a self-hosted Headscale

Run on 2026-10-27 against a real local Headscale v0.29.6 (single binary, SQLite, database policy mode, own embedded DERP map file, no Docker, no sign-up, no hosted account). `npm run live-check` result: **57 PASS, failed=0**, run twice in a row.

## Covered (26 of 30 operations, preview and confirmed)
- meta: health.
- users: create, list, rename, delete (get by id via list).
- preauth_keys: create (secret shown once, redacted in list), list, expire, delete.
- api_keys: create (secret shown once, redacted in list), list, expire, delete by the listed prefix (trailing `***` is stripped by the connector).
- policy: get (empty policy on a fresh server is read as ""), check, diff, set (preview shows diff and lockout warning), restore of the previous policy.
- debug + auth: debug_create_node makes a pending registration; auth_register turns it into a real node.
- nodes: get, list, rename, set_tags, set_approved_routes, expire, delete, plus a not-found error for an unknown node.
- Every write was first run unconfirmed (dry run) and then with `confirm:true` and `HEADSCALE_ALLOW_WRITES=true`. The script checks that no secret appears in any tool output.

## Not covered live
- auth_approve, auth_reject, register_node, backfill_node_ips: mock-tested only. They need a real Tailscale client mid-login, or touch IP allocation for existing nodes.
- No real Tailscale client ever joined, so node data came from the debug and register path.

## Quirks found by the live run and handled
- GET /api/v1/policy returns 500 "acl policy not found" on a fresh server. The connector reads this as an empty policy.
- API key delete and expire use the listed prefix without the trailing `***`.
- `authId` and registration keys are treated as secrets in redaction.
- tagOwners must use `user@` syntax.

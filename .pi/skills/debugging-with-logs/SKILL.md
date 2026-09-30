---
name: debugging-with-logs
description: Use when something fails at runtime and the cause is not visible in the output — a wrong route, a rejected request, an error on one user's data but not another's. Covers reading this project's logs and what each failure mode means.
---

# Debugging with logs

Use the `read_logs` tool, which calls `bun run logs`. Do not read log files
directly: the CLI applies redaction, bounds, and the same capability checks a
human gets, so a raw file read can show you a credential and can show you more
than the adapter is able to filter.

## Where the events are

| App | Local | staging / production |
|---|---|---|
| `api` | `/tmp/starter-logs/api.ndjson` | Cloudflare Logpush, then `wrangler tail` |
| `client` | the **same file** — the browser cannot write one | not available |

A browser cannot write a local file. Client events are forwarded to
`/api/telemetry`, the Worker records them, and `bun run dev:api` captures the
Worker's stream. They are told apart by `app` and `source`, not by filename.

## Reading a failure

Start narrow and widen. `--limit` is capped at 200 lines; the cap exists because
an unbounded dump ends the useful conversation.

```
read_logs(app="api", mode="local", level="ERROR")
read_logs(app="api", mode="local", traceId="trace_from_the_error")
read_logs(app="api", mode="local", uid="user_id")
```

`traceId` is the strongest filter. The client sends `x-trace-id`, the Worker
echoes it onto every log line for that request, and it appears in the error the
user saw. One trace id reconstructs one request end to end.

## Reading a refusal

A non-zero exit is an answer, not a tool failure. Each one means something
specific:

- `credentials_unavailable` — no Cloudflare token. Local mode never needs one;
  if you asked for production, that is the answer.
- `capability_unsupported` — you asked for a filter the active adapter cannot
  do. `wrangler tail` cannot filter by user id or trace id and has no history.
  This is deliberately an error rather than a silent no-op: an unbounded dump
  returned in answer to `--uid` would look like "no matching logs".
- `unavailable` — nothing is configured for that app and environment. For the
  client outside local, this is expected: browser events only exist where client
  telemetry forwarding is enabled, and round 1 does not enable it.

If you get `unavailable` for the client in production, that is not a bug to fix.
It is the honest answer.

## Before you conclude "no logs"

Run `read_logs(app="api", mode="local")` with no filters. If that is also empty,
the Worker is not running or is not capturing: check that `bun run dev:api` is
up, and that `/tmp/starter-logs/api.ndjson` has been touched recently. Wrangler
interleaves human-readable banners with the log JSON, and the reader skips
anything that is not a complete JSON object — a file of banners means the
capture failed, not that there are no events.

## Correlation ids in one place

- `traceId` — one request, client through Worker.
- `requestId` — one Worker request.
- `userId` — set only from a verified session, never from a request body.
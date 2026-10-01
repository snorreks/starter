# Logs

One command reads this project's logs, whatever produced them.

```bash
bun run logs <client|api|all> [flags]
```

## Quick start

```bash
bun run dev:api                                    # captures the Worker's stream
bun run logs all --mode local --follow             # tail it
bun run logs api --mode local --level error        # just failures
bun run logs api --mode local --trace trace_abc123 # one request, end to end
```

No credentials are needed for `--mode local`. That is deliberate: local log
verification is part of ordinary CI, and a check that needs an account is a check
nobody runs.

## Where the events are

| App | Local | staging / production |
|---|---|---|
| `api` | `/tmp/starter-logs/api.ndjson` | Cloudflare Logpush, then `wrangler tail` |
| `client` | the **same file** | not available |

There is no `client.ndjson`, and that is not an oversight: **a browser cannot
write a local file.** Client events are forwarded to `/api/telemetry`, the Worker
records them, and `bun run dev:api` captures the Worker's stream. They are told
apart by their `app` and `source` fields, not by a filename.

Mapping `client` to a file nothing writes would report "unavailable" forever,
which reads as a broken tool rather than as an accurate description.

For the same reason, browser and native events are **not available** in staging or
production. They only exist where client telemetry forwarding is enabled, and this
starter does not enable it. `bun run logs client --mode production` says so, and
that is the honest answer rather than a bug to fix.

## Flags

| Flag | Meaning |
|---|---|
| `--mode local\|staging\|production` | Where to read. Default `local`. |
| `--level DEBUG\|INFO\|WARNING\|ERROR` | Minimum severity. |
| `--source browser\|worker\|native\|cli` | Restrict to a producer source. |
| `--trace <id>` | Correlate to one request. |
| `--uid <id>` | Filter by a **server-verified** user id. |
| `--since <duration>` | How far back: `s`, `m`, `h`, `d`, `w`. |
| `--limit <n>` | Maximum events. Default 50, cap 500. |
| `--follow` | Stream live. `--duration` bounds it (default 60s, max 300s). |
| `--json` | Machine-readable. |

`--uid` accepts only a value the **server** recorded. Events the browser
self-reported about itself are not treated as verified, because a client can claim
any id it likes.

## Reading a failure

Start narrow, widen once.

```bash
bun run logs api --mode local --level error
bun run logs api --mode local --trace trace_from_the_error
bun run logs api --mode local --uid user_abc
```

`--trace` is the strongest filter. The client sends `x-trace-id`, the Worker
echoes it onto every line for that request, and it appears in the error the user
saw. One trace id reconstructs one request end to end.

## Every refusal is an answer

The CLI never silently ignores a flag it cannot honour. Each non-zero exit means
something specific, and the message says which:

| Status | Meaning |
|---|---|
| `credentials_unavailable` | No Cloudflare token. Local never needs one. |
| `capability_unsupported` | The active adapter cannot do that filter. |
| `unavailable` | Nothing is configured for that app and environment. |

`capability_unsupported` is the important one. `wrangler tail` has no index, so it
cannot filter by user id or trace id:

```bash
$ bun run logs api --mode production --uid user_abc --follow
[api] status=capability_unsupported
This adapter cannot filter by user id. `wrangler tail` is a live event stream
with no index, so it cannot filter by any field. Use `--mode local` or an
environment with Logpush enabled.
```

Silently returning everything in answer to `--uid` would look exactly like "this
user has no events" — so it is an error instead. The capabilities each adapter
declares live in `scripts/src/registry/app_registry.ts`, and the
CLI checks them *before* building a filter.

## Redaction

Every event is redacted on the way out, at three points: the logger, the Worker's
telemetry endpoint, and the log CLI.

Redaction is **field-name based**, not value-pattern based. Pattern matching over
free text produces false negatives (a token inside a sentence) and false positives
(a "token count"), and both are worse than an explicit list.

The trade-off is that a credential in a *value* is not caught:

```ts
logger.info('token', 'abc123')     // redacted — `token` is a known field name
logger.info('note', 'token: abc')  // not redacted — the text is the message
```

So the second rule of this repository is: never log a value. Log a field name.

`redactValue` also never throws and never recurses without a bound — it runs on
the logging path, where a cyclic or hostile payload must not be able to hang or
crash the process trying to report the problem.

## When there are no logs

If `bun run logs api --mode local --level DEBUG` is also empty, the Worker is not
running or not capturing. Check that:

```bash
curl -s http://127.0.0.1:8787/api/health
ls -la /tmp/starter-logs/
```

Wrangler interleaves human-readable banners with the log JSON, and the reader
skips anything that is not a complete JSON object. A file of banners means the
capture failed, not that there are no events.

## In CI

```bash
bun run dev:api &                  # or however your CI starts it
sleep 5
bun run logs api --mode local --json > logs.ndjson
```

`--mode local` reads a file, so it needs no secret. Upload `logs.ndjson` as an
artifact when the run fails.

## From an agent

The Pi extension exposes this as a `read_logs` tool, so an agent debugs against
the same adapters and capability rules a human does. It caps output at 200 lines
and never passes `--follow`: a tool call that never returns blocks the agent.

See [agent.md](agent.md).
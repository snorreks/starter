# Logs

One command reads this project's logs, whatever produced them.

```bash
bun run logs web [flags]
```

There is one app. Its Worker half and its browser half both log under `app=web`, and
`source` (`worker` vs `browser`) is what tells them apart. `all` is accepted as a
synonym for the one app so a script that already passes it keeps working.

## Quick start

```bash
bun run dev                              # captures the app's stream
bun run logs web --mode local --follow   # tail it
bun run logs web --mode local --level error        # just failures
bun run logs web --mode local --trace trace_abc123 # one request, end to end
bun run logs web --mode local --source browser     # just the browser's half
```

No credentials are needed for `--mode local`. That is deliberate: local log
verification is part of ordinary CI, and a check that needs an account is a check
nobody runs.

## Where the events are

| Source | Local | staging / production |
|---|---|---|
| `worker` | `.wrangler/logs/app.ndjson` | Workers Observability query, or `wrangler tail` for `--follow` |
| `browser` | the **same file**, via `/api/telemetry` | only where forwarding runs |
| `cli` | the same file, when a script logs through the CLI | Workers Observability query |

There is no `browser.ndjson`, and that is not an oversight: **a browser cannot write
a local file.** Browser events are forwarded to `/api/telemetry`, the same Worker
records them, and `bun run dev` captures its stream. A browser-forwarded event keeps
`source: 'browser'` — the Worker is reporting what it received, not claiming it
produced it.

Mapping `browser` to a file nothing writes would report "unavailable" forever, which
reads as a broken tool rather than as an accurate description.

For the same reason, browser events are **not available** in staging or production
by default. They only exist where telemetry forwarding is enabled, and the
`client-forward` capability that serves them declares `historicalQuery: false`,
which is the honest statement. `bun run logs web --mode production --source
browser` says so rather than returning nothing.

## Flags

| Flag | Meaning |
|---|---|
| `--mode local\|staging\|production` | Where to read. Default `local`. |
| `--level DEBUG\|INFO\|WARNING\|ERROR` | Minimum severity. |
| `--source browser\|worker\|cli` | Restrict to a producer source. |
| `--trace <id>` | Correlate to one request. |
| `--uid <id>` | Filter by a **server-verified** user id. |
| `--since <duration>` | How far back: `s`, `m`, `h`, `d`, `w`. |
| `--limit <n>` | Maximum events. Default 50, cap 500. |
| `--follow` | Stream live. `--duration` bounds it (default 60s, max 300s). |
| `--json` | Machine-readable. |

The `--source` list is written from `LOG_SOURCES` in `@starter/schemas`, not from a
second literal in the CLI. It used to carry `native`, which stopped existing when
the native shell was removed — and `--source native` then parsed successfully and
matched nothing, which is the worst kind of no-op.

`--uid` accepts only a value the **server** recorded. Events the browser
self-reported about itself are not treated as verified, because a client can claim
any id it likes.

## Reading a failure

Start narrow, widen once.

```bash
bun run logs web --mode local --level error
bun run logs web --mode local --trace trace_from_the_error
bun run logs web --mode local --uid user_abc
```

`--trace` is the strongest filter. The browser sends `x-trace-id`, the Worker
echoes it onto every line for that request, and it appears in the error the user
saw. One trace id reconstructs one request end to end — across both halves, because
they are one process now rather than two.

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
$ bun run logs web --mode production --uid user_abc --follow
[web] status=capability_unsupported
This adapter cannot filter by user id. `wrangler tail` is a live event stream
with no index, so it cannot filter by any field. Drop --follow to use the
Workers Observability query, which can filter by user id, or use --mode local.
```

Silently returning everything in answer to `--uid` would look exactly like "this
user has no events" — so it is an error instead. The capabilities each adapter
declares live in `scripts/src/registry/app_registry.ts`, and the CLI checks them
*before* building a filter.

An app this project does not deploy is refused by name rather than by throwing:

```bash
$ bun run logs api --mode local
Unknown app "api". This project deploys: "web".
```

It used to be a `TypeError` naming an array index. A refusal that says what was
wrong is the difference between a fixable report and a puzzle.

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

If `bun run logs web --mode local --level DEBUG` is also empty, the app is not
running or not capturing. Check that:

```bash
curl -s http://127.0.0.1:5173/api/health
ls -la .wrangler/logs/
```

`bun run dev` writes the same stream from both modes. Under Node there is no
platform console capture, so the server writes NDJSON itself; under workerd the
platform captures console output and wrangler prints it as JSON. Either way the
reader skips anything that is not a complete JSON object — so a file of banners
means the capture failed, not that there are no events.

## In CI

```bash
bun run dev:worker &              # or however your CI starts it
sleep 5
bun run logs web --mode local --json > logs.ndjson
```

`--mode local` reads a file, so it needs no secret. Upload `logs.ndjson` as an
artifact when the run fails.

## From an agent

The Pi extension exposes this as a `read_logs` tool, so an agent debugs against
the same adapters and capability rules a human does. It caps output at 200 lines
and never passes `--follow`: a tool call that never returns blocks the agent.

See [agent.md](agent.md).
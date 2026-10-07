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
bun run logs web --mode local --run e2e_run_42     # one owned run only
```

No credentials are needed for `--mode local`. That is deliberate: local log
verification is part of ordinary CI, and a check that needs an account is a check
nobody runs.

## Logging in code

Use the same import in app and shared code:

```ts
import { logger } from '#logger';

logger.info('Cache refreshed');
```

Each app's `package.json` maps `#logger` to its runtime adapter. Shared packages
that log map it to the `@starter/logger` facade, which delegates to the app logger
registered at startup. The shared contract is `LoggerInterface`; an app selects the
console, browser, or Worker implementation.

For a server request, use `locals.context.logger` when the record needs request
context such as its trace or verified user. That logger is created per request;
the imported app logger is process-wide and must not hold request-specific values.

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
| `--run <run-id>` | Read one local run under `.wrangler/runs/<run-id>/logs`; local mode only. |
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

## One record, one destination

Every record leaves through exactly one emitter, chosen per runtime:

| Runtime | Destination | Why |
|---|---|---|
| workerd | one JSON object through `console`, on the console method for its level | `wrangler tail`, Workers Logs and Logpush index console output. Nothing else in a Worker is captured. |
| Node | one NDJSON line on stdout | `bun run dev` redirects stdout into `.wrangler/logs/app.ndjson`, which is what `--mode local` reads. |

Two consequences worth stating, because both were defects:

- **`silent` is not a destination.** It suppresses the human-formatted render and
  nothing else. `createLogger` now refuses `silent: true` with no sink and no
  memory sink, because a logger configured that way emits nowhere — which is what a
  deployed Worker was doing, silently, while every other signal looked healthy.
- **The level is the lowest severity emitted.** It used to compare the other way
  round, so a logger at the default `INFO` emitted only `DEBUG` and dropped
  `ERROR`. If a record you expect is missing, check this before blaming the sink.

## Identity, and what a client is allowed to claim

A record's identity comes from the session, never from a payload.

| Field | Who decides it |
|---|---|
| `traceId` | The server, generated per request. |
| `requestId` | The provider's `cf-ray`, bounded to `[A-Za-z0-9._:-]` and 200 characters, or omitted. |
| `userId` | The verified session, or absent. |
| `environment` | `container.environment`, after validation. A staging deployment records `staging`. |
| `source`, `release`, `level`, `timestamp` on a **forwarded** record | Client claims, validated against the schema and kept — a browser event retains its source, artifact release, severity and event time. |
| client identity claims | `data.clientReported`, labelled, including a submitted top-level `userId` or `traceId`. |
| an incoming `x-trace-id` header | `data.clientTraceId` on the request record — never the trace id. |

The redaction described above is applied to the forwarded payload, and the redacted
payload **is** stored. It used to be redacted into a local variable and then dropped.

## `/api/telemetry` bounds

| Bound | Value | Unit |
|---|---|---|
| `MAX_BODY_BYTES` | 16 KiB | bytes per submission, refused before parsing (413) |
| `MAX_RECORDS_PER_SUBMISSION` | 20 | records, refused by the schema (422) |
| `MAX_SUBMISSIONS_PER_WINDOW` | 60 | **submissions** per minute per caller, isolate-local |

The submission counter lives in an isolate-local `Map`. It is a brake on a loop, not
accounting: no durability, no sharing between isolates. It is not a security control,
which is why deployed ingestion requires a session — local development still accepts
an anonymous submission, bounded by the two ceilings above, because that is how a
browser console is diagnosed without inventing an account.

A record that fails to store is reported in the response body (`accepted`,
`submitted`, `rejected`) and never fails the request. Notes and sign-in do not break
because a log write threw.

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
reader skips anything that is not a complete JSON object. It strips Wrangler's
`stdout: ` label before parsing structured workerd records. For an owned `dev` or
`built` run, pass `--run <run-id>` to read only that run's log file; browser network
entries and matching Worker request records can then be compared by route and time.
A file of banners with no records means capture failed, not that there were no
events.

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

# @starter/logger

Structured logging for every plane: the browser, the Worker and the CLI. One event
shape, one redaction pass, one destination per runtime.

## What is here

- `LogEvent` (`@starter/schemas/logging`) is the one shape every plane emits and
  every consumer reads — console, `bun run logs`, the telemetry endpoint, the Pi
  `read_logs` tool.
- `toLogEvent` (`lib/event_log.ts`) is the single place a `LogEntry` plus a context
  becomes that shape. Redaction, depth bounds and size bounds happen here, before
  any sink can see the record.
- `lib/structured_output.ts` holds the two destinations a server record has:
  `createStructuredConsoleEmitter` (one JSON object through `console`, on the method
  for its level — what workerd's platform capture indexes) and
  `createNdjsonStdoutEmitter` (one JSON line on stdout — what `bun run dev`
  redirects into `.wrangler/logs/app.ndjson` and `bun run logs --mode local` reads).
  Both never throw.
- `BrowserLogger` + `createHttpTelemetryTransport` is the browser forwarding path.
  It is opt-in and is *not* a server log.
- `spam(id, ...)` is the answer to a hot call site; it heartbeats while throttled.

## Two rules this package enforces

- **`silent` is not a destination.** It suppresses the human-formatted render and
  nothing else. `createLogger` refuses `silent: true` with no sink and no memory
  sink, because a logger configured that way emits nowhere — which is exactly what
  the Worker was doing, silently, while the application looked healthy.
- **The configured level is the lowest severity emitted.** If a record you expect is
  missing, check this before blaming the sink.

## Commands

```bash
bun run --cwd packages/shared/logger test        # unit tests, including the level table
bun run --cwd packages/shared/logger typecheck
bun run --cwd packages/shared/logger lint
```

## Boundaries

This barrel is **browser-safe**: everything exported from `src/index.ts` must load
in a browser bundle with no Node built-ins. `NdjsonFileSink` uses `node:fs` and is
deliberately not exported here — import it from `@starter/logger/file`. The package
depends only on `@starter/schemas`; it imports nothing from `apps/` or `scripts/`.

## Canonical docs

[logs](../../docs/logs.md) · [architecture](../../docs/architecture.md) ·
[testing](../../docs/testing.md)
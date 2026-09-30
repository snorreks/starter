# @starter/logger

Structured logging shared by the client, the API and the CLI.

- `LogEvent` (`@starter/schemas/logging`) is the one shape every plane emits.
- Redaction happens **before** any sink, so no sink can become the leak.
- Sinks cannot throw, and a failing sink is disabled rather than retried.
- `spam(id, ...)` is the answer to a hot call site; it heartbeats while throttled.
- `BrowserLogger` + `createHttpTelemetryTransport` is the browser/native
  forwarding path. It is opt-in and is *not* a server log.

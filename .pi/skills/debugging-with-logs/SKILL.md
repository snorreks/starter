---
name: debugging-with-logs
description: Use when a runtime failure is not visible in the immediate output. Covers this project's web Worker and browser log sources, supported filters, and honest interpretation of empty or unavailable results.
---

# Debugging with logs

Use `read_logs`, which calls `bun run logs`. The CLI applies redaction, bounds,
and the same capability checks as a human command. Do not read raw log files to
work around an unsupported filter.

The app is `web`; `source` distinguishes the Worker from browser events. The
local dev server writes both to `.wrangler/logs/app.ndjson` through the
project-owned log directory. Start it with `bun run dev`.

```text
read_logs(app="web", mode="local", source="worker", level="ERROR")
read_logs(app="web", mode="local", source="browser", since="15m")
read_logs(app="web", mode="local", traceId="trace_from_the_error")
read_logs(app="web", mode="local", runId="e2e_run_42")
```

`source` accepts `worker` or `browser`. `since` accepts the CLI's duration units
such as `15m` or `2h`. The result is capped at 200 lines and the tool does not
follow an unbounded stream. A selected trace is the strongest request filter:
the Worker records the request trace and browser telemetry carries the same
correlation id when available.

A nonzero CLI result, timeout, cancellation, or spawn failure is a tool error.
Relay its message and remedy. `credentials_unavailable` means a remote query
needs Cloudflare access; local mode needs no credentials. `capability_unsupported`
means the active adapter cannot honor a filter. Empty local results mean no
events matched in the checkout's log directory, not that another worktree's
logs were checked. Use `runId` to read one harness run; an unknown run returns an
unavailable result and never falls back to the checkout's default log file.

Before concluding that there are no logs, read the local `web` logs without a
source or trace filter. If the CLI reports that the file is unavailable, check
whether `bun run dev` is running. Human-readable Wrangler banners may share the
file; the parser ignores lines that are not complete JSON objects.

Correlation fields have different owners: `traceId` identifies a request,
`requestId` identifies a Worker request, and `userId` comes from a verified
session.

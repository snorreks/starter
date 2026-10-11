# @starter/live

Liveness for a screen: how it learns that what it is showing may be stale.

## Purpose

A screen that loads its data once is correct until something else changes it. This
package is the seam between a screen and whatever tells it to look again.

It exists because the honest answer to "make this live" is usually two mechanisms,
not one:

- **Polling** — re-read on a bounded interval. Always available, needs no
  infrastructure, costs requests, and is the only thing that works when a socket
  does not.
- **Push** — a server tells the browser something moved. Immediate, needs
  infrastructure, and fails in ways a polling loop does not.

Picking one and calling it "live" is how a screen ends up silently stale. This
package defines the contract both implement, so the choice is the host's, a
fallback is a substitution rather than a mode flag buried in a class, and the
screen can tell the user which one it currently has.

**The contract is an invalidation, not a message.** A notification carries no
content: it says "topic X may have moved", and the screen re-reads its own
authoritative snapshot through the service it already has. The transport is
therefore never a second source of truth, there is nothing to authorize per
message, and a dropped or duplicated notification is harmless because it was only
ever a hint. See `src/contract.ts` for why each of those is load-bearing rather
than tidy.

## Setup and commands

Nothing to configure. The package has no dependencies at all — not on other
workspace packages — which is the property the repository's dependency guards
protect. A future import of `@starter/utils` here has to be a decision.

```bash
bun run --cwd packages/shared/live test        # unit lane
bun run --cwd packages/shared/live typecheck
bun run --cwd packages/shared/live lint
bun run --cwd packages/shared/live format
```

## Validation

`bun test` in this package. Eleven cases, all driving an injected
`LiveScheduler` and asserting on **when** something fired rather than on real
elapsed time, because the properties worth protecting are about stopping and
backing off, not about polling at all:

- a poll with no subscribers holds no timer, and closing the last one clears it;
- an interval that reported no change widens by `backoff` toward `maxMs`, and one
  that did collapses to `baseMs` **immediately** rather than after the long
  interval already armed;
- no interval ever exceeds `maxMs`;
- a subscriber that closes inside its own callback is never called again, and
  nothing fires after `close()`;
- an inactive host holds no timer, and `refresh()` delivers exactly once on
  return;
- `observe` reports the current mode on subscribing, and the manual
  implementation reports `disabled` and delivers nothing.

Both timing behaviours were checked against deliberate mutations — removing the
`clearTimer()` in `close()`, and removing the collapse in `notifyChanged()` — and
each turned the suite red.

The last case asserts the suite is still complete. `bun:test` in this version
exports no way to enumerate collected tests, so the count is taken at
registration time; it cannot prove the file ran, only that the cases are still
there.

## Boundaries

**Portable.** This package imports nothing from `apps/` or `scripts/`, and has no
workspace dependencies. Both the web application and the native shell may adopt
it, and a third application may adopt only the polling half.

**Not a message broker.** There is no publish API, no queue, no retained history
and no replay. A topic is an opaque string the *host* composes; this package
never parses one, so `conversation:<id>` is one application's convention and not
something here.

**Never finds its own collaborators.** `createPollingLiveUpdates` takes its
scheduler, its bounds and its visibility predicate as arguments. A screen takes a
`LiveUpdates` as a constructor dependency for the same reason it takes a
transport or a `Navigation`: a feature that reached for an ambient transport
could only ever run in one host.

**Does not know what data it is invalidating.** It calls a callback and nothing
more. Ordering of the resulting reads is the screen's problem, and the screen
already owns a guard for it.

**Does not open sockets.** There is no WebSocket implementation here yet. The
`LiveUpdates` interface is the extension point for one, and a host that has none
uses `createManualLiveUpdates` rather than passing `null` and null-checking at
every call site.
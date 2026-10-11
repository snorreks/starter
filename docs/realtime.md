# Realtime

How a screen in this application learns that what it is showing may be stale, and
what it costs.

## Why this document exists

`packages/shared/schemas/src/chat/stream.ts` has cited this file as the authority
on stream resumption since the SSE transport was written. It did not exist. A
comment that points a reader at a missing document is worse than one that points
nowhere: the reader concludes the thing is not implemented, when in this case it
mostly was.

## What "live" means here, precisely

There is no realtime anywhere in this application by default. A screen loads its
data, and it changes when something makes it re-read. Three things make it
re-read:

| Mechanism | Latency | Cost | When it applies |
|---|---|---|---|
| **Client-side navigation** | immediate | one request | SvelteKit re-runs the load |
| **Polling** | 1.5s widening to 20s | one request per interval per visible screen | always available |
| **Push** | one round trip | a connection, a Durable Object request per fan-out | only where configured |

**Polling is the baseline and is always correct.** It is not a degraded mode that
gets switched off when push arrives; it is what runs when push is absent,
refused, disconnected, or disabled. A screen that loses its socket keeps working,
and says so: `LiveUpdates.mode` distinguishes `polling` from `disabled`, and a
screen exposes its own `liveMode`.

### The push path, and why it is a second Worker

Push is a WebSocket, and **SvelteKit cannot serve a WebSocket upgrade**.
`@sveltejs/adapter-cloudflare` 8.0.0 generates an entry that exports only
`fetch(req, env)` and keeps the SvelteKit `server` module private, and its
`AdapterOptions` exposes no custom-entry hook. The two ways out:

1. **Own the application's Worker entry** — wrap the adapter's default export and
   intercept the upgrade before delegating. One Worker, one hostname, but the
   output of `vite build` is now forked: every adapter upgrade can break the
   socket path silently, and `vite dev` never has the route at all, because
   `getPlatformProxy` supplies bindings but does not run `main`.
2. **A separate `live` Worker** — chosen. The cost is a third deployed Worker; the
   benefit is that the application's entry stays exactly as the adapter emits it.

The socket endpoint lives in `apps/backend/live`. It holds connections and fans
out invalidations. It holds **no Supabase credential**, reads no message, and
writes nothing. A compromised live Worker leaks the fact that somebody is online,
not what they said.

### What travels over a socket: nothing

A notification is a **topic name and nothing else**. The browser that receives
`conversation:abc` re-reads through the application it is already authenticated
to.

This is deliberate and it is the difference between a notification and a message
bus:

- the transport is never a second source of truth;
- there is nothing to authorize per message — a subscription is authorized once,
  at attach, against the same owner check the REST read performs;
- a dropped or duplicated notification is harmless, because it was only ever a
  hint. Recovering a dropped *message* is where realtime systems accumulate state
  they cannot evict.

Because a notification carries nothing, the client cannot render from it. It
re-reads. That is also why `docs/…/chat/stream.ts` says the SSE turn carries no
`id:` field: `Last-Event-ID` is only honoured if the server keeps a buffer, and
this application does not, so a reconnect starts the turn again rather than
resuming it.

### Authentication across two Workers

The browser's credential is the first-party session cookie, and it does not travel
with an upgrade to another hostname. Re-scoping that cookie to a parent domain so
it would would weaken it for every other route.

So `POST /api/live/ticket` — an ordinary cookie-authenticated SvelteKit route —
mints a short-lived HMAC ticket, and the browser presents it in
`Sec-WebSocket-Protocol`. **Not in the query string**: URLs land in access logs,
proxy logs and `Referer`. The server echoes only the protocol name, never the
credential.

Default lifetime is **30 seconds** (`LIVE_TICKET_TTL_MS`). It is defence in depth,
not the only thing protecting a transcript: a stolen ticket is worth a socket for
whoever holds it, which is why the lifetime is short and why every subscription is
still authorized against the verified owner afterwards.

## Failure behaviour

| What fails | What the user sees | Why |
|---|---|---|
| `LIVE_TICKET_SECRET` missing or under 32 chars | every handshake refused 503 | degraded authentication is worse than none |
| ticket expired | handshake refused 401 | 30s is longer than any honest handshake |
| socket disconnects | `mode: 'polling'`, screen keeps updating | the baseline is always available |
| subscription denied | socket closed 1008, client falls back | retrying harder cannot grant permission |
| the authorize Worker unreachable | **denied** | an outage must not become an authorization bypass |
| a poll fails | nothing; the screen is as stale as it was | a timed-out poll should not replace a readable transcript with an error |

## Free-tier limits

Cloudflare's Free plan is the constraint that decides whether this is viable, and
the numbers below are the ones that bite:

- **Workers Free: 100,000 requests/day.** Every WebSocket **handshake** counts as
  a request, and so does every `fetch` to a Durable Object. A hibernated socket
  holds a connection, not a request, so an *idle* subscriber is close to free —
  but a client that reconnects in a loop is not.
- **Durable Objects Free: 100,000 requests/day, and SQLite-backed DO is
  available.** Each `subscribe` and each `publish` is one DO request. A publish
  costs one request per *user object* touched, not one per socket.
- **WebSockets are limited to 1 concurrent connection per request**, which is the
  model here: one socket per browser tab.
- **Cron, R2 and Workflows are unaffected** — this Worker uses none of them.

The practical ceiling is a few hundred concurrent users with well-behaved clients.
Two behaviours dominate, and both are client-side decisions:

1. **Reconnect backoff.** A client that reconnects immediately on failure turns a
   brief outage into a request flood, which on the Free plan turns a degraded
   service into an unavailable one.
2. **Idle sockets.** A socket with no subscriptions and no traffic should be
   closed by the client after a period. A hibernated object is cheap; it is not
   free.

## When the Workers Paid plan becomes necessary

Pay is required when any of these is true:

- sustained handshakes or Durable Object requests exceed 100,000/day, which at one
  handshake per tab session means roughly 100,000 page visits a day;
- more than three Durable Objects per account is needed — this design uses one per
  user, so **this is the hard limit**: the Free plan allows 3, so it works for a
  development or demonstration deployment and **does not scale past a handful of
  concurrent users**;
- WebSocket connection duration limits on the plan become the binding constraint
  rather than the request budget.

**The Durable Object count is the important one.** One object per user is the
simplest design and it does not survive the Free plan. Moving to many objects per
user — sharding by topic — is the change that makes this viable at scale, and it is
a change to `idFromName` in `apps/backend/live/src/index.ts` and nothing else,
which is why the identity is passed to the object as a header rather than inferred.

## What is verified, and what is not

| | |
|---|---|
| Polling: stops, backs off, collapses, survives teardown | **verified**, 11 cases in `packages/shared/live` |
| Polling: mutating `close()` or `notifyChanged()` turns the suite red | **verified** |
| The ticket: forgery, expiry, wrong secret, wrong handshake order | **verified**, 21 cases in `packages/backend/auth` |
| The wire protocol: round trip, colon-bearing topics, tag confusion | **verified**, 8 cases in `apps/backend/live` |
| Screen reaction to an invalidation, both chat screens | **verified**, 16 cases in `packages/frontend/features` |
| The Durable Object in real workerd: hibernation, fan-out, per-subscription authorization | **NOT RUN** — the worker's integration lane has not been written |
| The socket end to end against a deployed Worker | **NOT RUN** — nothing publishes to the hub yet |

The last two rows are the honest state of this work. See
`.pi/handoffs/live-chat-updates.md`.
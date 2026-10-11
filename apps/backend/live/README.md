# @starter/live-worker

The live Worker: WebSocket connections, and nothing else.

## Purpose

It holds WebSocket connections and fans out invalidations. It stores no message,
answers no read, and holds no Supabase credential. Postgres is the source of
truth and the only copy of anything.

It exists as a **second** Worker because SvelteKit cannot serve a WebSocket
upgrade. `@sveltejs/adapter-cloudflare` generates an entry that exports only
`fetch` and keeps the SvelteKit server private, and its `AdapterOptions` has no
custom-entry hook — so a socket cannot be a route in the web application. The
alternative, teaching the web Worker to own its own entry, means forking generated
adapter output that is replaced on every build. See the note at the top of
`src/index.ts`.

The division of authority is the whole design:

| Decides | Where | Because |
|---|---|---|
| who may **connect** | this Worker | it holds the ticket signing secret and verifies the handshake |
| what a subscriber may **watch** | the application Worker | only it has a verified session and the RLS-scoped owner check |
| who is **connected** | the Durable Object | one object per user, holding that user's sockets |

This code executes in **workerd**, and in `miniflare` for the integration lane.
It is not browser code and never will be.

## Setup and commands

A fresh checkout needs nothing to build or test it. `bun install` is enough.

- `LIVE_TICKET_SECRET` is a **secret** and is deliberately absent from
  `wrangler.jsonc`. `deploy:provision` installs it per environment. A committed
  value would be a signing key in the repository that verifies against a deployed
  Worker, so `bun run check:config` fails the build if one long enough to sign
  with appears there.
- `AUTHORIZE` binds the application Worker that checks topic access. Service
  bindings are declared for local, staging, and production because Wrangler does
  not inherit them between environments.
- `LIVE_HUB` and the `v1` migration are committed in `wrangler.jsonc`.
- The Durable Object is SQLite-backed (`new_sqlite_classes`); the storage used is
  the runtime's own socket hibernation, not anything written to that database.

```bash
bun run --cwd apps/backend/live test           # unit lane: the wire protocol
bun run --cwd apps/backend/live check:config   # binding, migration, no committed key
bun run --cwd apps/backend/live build          # the bundle wrangler deploy ships
bun run --cwd apps/backend/live typecheck
bun run --cwd apps/backend/live lint
```

## Validation

- **`bun run test`** — the unit lane, `src/**/*.test.ts`. Eight cases over
  `src/protocol.ts`, all about one question: can the two ends of the wire disagree
  about where a frame's payload begins. It covers round-tripping, a
  colon-bearing topic surviving whole, the empty-topic refusal, the two frames
  staying distinguishable from each other, and a reader refusing a close or a
  proxy payload rather than guessing.
- **`bun run check:config`** — prints one line and exits nonzero on: a missing
  `LIVE_HUB` or `AUTHORIZE` binding, a binding naming a class other than `LiveHub`, a missing
  migration (whose real failure is an opaque upload error), or a committed signing
  key.
- **`bun run build`** — emits `dist/index.js` and fails on an empty output. The
  directory is emptied *before* the build, so a failed build never leaves the
  previous Worker looking current.

The Durable Object's own behaviour — hibernation, fan-out, per-subscription
authorization — needs a real runtime and is **not** covered by this lane. That
coverage belongs to the client's worker-integration lane, where the built Worker
is driven in workerd. It has not been written yet; see the handoff note.

## Boundaries

**May import** `@starter/auth` (the ticket protocol), `@starter/logger`,
`@starter/schemas`, `@starter/utils`. **May not import** the web application, any
`packages/frontend/*`, or anything under `scripts/` — a Worker that reached for
the application would drag SvelteKit into a bundle that has no use for it, which
is the reason `packages/backend/jobs` exists as its own project.

`MAY_REACH` and the architecture guard enforce this, and
`PLANE_PLACEMENTS` classifies this directory as `worker`. An unclassified file has
no plane, so no rule can say anything about what it imports — which is why the
classification is a guard input rather than a comment.

**Never imports Postgres.** A compromised live Worker leaks the fact that somebody
is online; it does not leak what they said.

See `docs/realtime.md` for the architecture, the Free-tier limits, and the
circumstances under which the Workers Paid plan becomes necessary.
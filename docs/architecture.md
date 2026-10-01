# Architecture

The dependency direction is one-way, and two independent mechanisms enforce it:
Biome checks import statements, and `bun run guard` checks layer membership.
Neither is sufficient alone — Biome cannot parse an import graph for a Worker, and
a linter cannot see a `// TODO` in a comment.

```
shared/     schemas, logger, utils          no project dependencies
backend/    database, auth                  -> shared
frontend/   ui, services                   -> shared
api                                         -> shared, backend
client                                      -> shared, frontend
scripts, .pi, e2e                          -> shared
```

The rule behind it: **shared code must be portable.** It runs in a Worker, in a
browser, and in a Tauri webview. The moment `packages/shared/utils` imports
`drizzle-orm`, that import is either dead code in two of those three places or a
runtime failure in one. Either way the shared package stops being shared.

## The layers

### `packages/shared` — portable, no dependencies

| Package | What it is |
|---|---|
| `schemas` | TypeBox schemas and the project registry. The single source of truth for what a note *is*, validated identically by the client and the Worker. |
| `logger` | Structured logging, redaction, sinks. |
| `utils` | `BaseClass`, `StaleGuard`, observers, `AppError`, slugs. |

Depends on nothing in the workspace. That is what makes the client and the Worker
agree by construction rather than by discipline.

### `packages/backend` — server only

`database` (Drizzle schema and migrations for D1) and `auth` (Better Auth
configuration). Neither may be imported by the frontend: `drizzle-orm` fails on
its first query in a browser, and `better-auth` is a server library.

### `packages/frontend` — browser and webview

`ui` (Svelte components) and `services` (client-side service abstractions). Neither
may import `node:*` or `bun:*`: they run where those do not exist. Platform work
goes behind an adapter here, not behind a runtime check.

### `apps/backend/api` — the Worker

Elysia 1.4. Reads bindings from the fetch signature, builds a container per binding
set, and resolves the user per request.

### `apps/frontend/client` — the app

SvelteKit 3 with Svelte 5. The same bundle runs in a browser and in a Tauri
webview; which one it is, it cannot tell, and nothing in it tries.

### `apps/e2e` — Playwright against the real thing

Tests-only. Depends on `shared` so it can build fixtures from the same schemas the
app uses — a fixture built from a hand-written object would not catch a schema
change.

## A request, end to end

```
browser                    Worker (workerd)
───────                    ────────────────
viewModel.load()
  └ StaleGuard.begin()       (token + AbortSignal)
  └ notesService.list()
      └ ApiClient.get()
          POST /api/notes ──▶ new Elysia()
                             container = getContainer(env)   // per binding set
                             ctx = buildRequestContext(request, container)
                                                 // user, traceId, logger
                             Elysia routes
                             drizzle query (ownerId from session)
          ◀── NoteListSchema
      └ AppError | NoteList
  └ isCurrent(token)?
      └ $state  ──▶ DOM
```

Three decisions in that flow are load-bearing.

**Bindings are memoized per binding set, not per request.** `env` is a stable
object for a given binding set in workerd, so a `WeakMap` keyed on it gives one
container without a module-level singleton that could outlive its bindings. User
identity is *not* memoized — it is rebuilt per request.

**Request state is never module-level.** `scripts/src/lib/guards/boundary.ts`
fails the build on a module-level `let env`, because a Worker isolate serves many
concurrent requests and the last writer wins for all of them. The failure is rare,
non-reproducible, and looks like a bug in the business logic.

**Auth is mounted last.** `.mount()` on a plain function drops every route
registered after it. This cost an afternoon once; the comment in `index.ts` says so.

## Frontend conventions

Four layers, and each has one job.

```
route page  →  constructs a ViewModel, hands it to the view
ViewModel   →  state. $state, StaleGuard, a tagged-union status
service     →  I/O. Calls ApiClient, returns types, lets AppError propagate
component   →  formatting, and raising intents
```

A route page that grows a second responsibility has the wrong responsibility in
it. There is no mechanism stopping that, which is why it is written down.

**`status` is a tagged union** — `loading | ready | error` — never a boolean plus a
separate error field. Two independent fields admit the state where both are set,
which is the state nobody handles.

**`StaleGuard` for anything async.** It aborts the superseded request rather than
ignoring it, so a user typing "a" then "ab" cannot have the "a" results arrive
last and win. Ignored requests still occupy a connection and still cost server
work.

**No `as unknown as`, no `as any`.** When a cast is needed, the boundary is wrong.
This is a review rule, not a compiler rule.

## API conventions

**Ownership is enforced in the query:**

```ts
.where(and(eq(notes.id, params.id), eq(notes.ownerId, user.id)))
```

Not "fetch, then check whether `row.ownerId === user.id`". The second version has
already returned the row to a function that can log it.

**`additionalProperties: false` on every schema.** That is what makes
`Value.Check` a refusal rather than a coercion mechanism. Without it an unknown
field is silently dropped and the client is told the write succeeded.

**`ownerId` never appears in a create payload.** Ownership comes from the session.
`apps/backend/api/src/lib/notes.ts` builds the row from `user.id`, and the create
schema rejects a body that carries one — refused, not ignored.

## Deliberate non-goals

- **No multi-tenancy.** One account owns its rows. An organization concept would
  change every query and every route, and it should be designed rather than
  retrofitted.
- **No plugin framework.** One router, one TypeBox, one base class. A framework
  for the second use of a concept is written by the person who has the second
  use.
- **No SvelteKit server actions.** The API is a Worker on its own domain. Server
  actions would put a second, differently-authenticated path in front of the same
  data, and the rules for it would not be the rules in this document.
- **No paid observability.** `bun run logs` reads files locally and Logpush
  remotely. Both are already enough to answer "what happened to this request".

## See also

- [adding-a-feature.md](adding-a-feature.md) — the order that works, and why
- [testing.md](testing.md) — what each lane can and cannot tell you
- [lint.md](lint.md) — what the linter enforces, and what it cannot
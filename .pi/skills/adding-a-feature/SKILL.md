---
name: adding-a-feature
description: Use when adding an entity, endpoint or screen to this project — anything that needs a schema, a route, a ViewModel, a service and tests. Covers the order of the work and the conventions that the guards enforce.
---

# Adding a feature

The order matters. Each step depends on the one before it being right, and the
guards fail on convention violations rather than on incomplete features.

The worked example this guidance refers to is the **jobs screen**
(`packages/frontend/features/src/jobs/`, routes `/jobs` in
`apps/frontend/client` and `apps/frontend/native`). It is the fullest example in
the repository because it has a lifecycle rather than a form; the notes screen is
the smallest. Both follow the same eight steps.

## 1. Schema first

`packages/shared/schemas/src/<domain>/`

One file per entity. The schema is the single source of truth for the client's
type, the Worker's validation, and the database column types.

```ts
export const ThingSchema = Type.Object({
  id: ThingIdSchema,
  ownerId: UserIdSchema,          // ownership is almost always present
  name: Type.String({ minLength: 1, maxLength: 120 }),
  createdAt: Type.Number(),        // epoch milliseconds
}, { additionalProperties: false });
export type Thing = Static<typeof ThingSchema>;
```

Set `additionalProperties: false` on every object. It is what makes
`Value.Check` a refusal rather than a coercion mechanism: without it an unknown
field is silently dropped, and the client is told the write succeeded.

Derive the create and update schemas separately. `NoteCreateSchema` must not
accept `ownerId` — ownership comes from the session, never from the body — and
`NoteUpdateSchema` sets `minProperties: 1` so an empty PATCH is refused.

Add a `validateXInput` alongside when the client should show the message without
a round trip. Keep it in step with the schema; there is a test asserting they
agree.

**State the facts the server refuses to invent.** `JobDtoSchema` has four statuses
and no fifth: artifact expiry is `outputAvailable: false` on a job that still says
`succeeded`, because a terminal outcome that depends on a later clock cannot be
told apart from a failure. `LatestMaintenanceSchema` carries the trigger and the
slot, because "the schedule fired" and "somebody pressed the button" are different
claims and a single timestamp would collapse them.

## 2. Migration

```bash
bun run db:generate     # writes a SQL file
bun run db:migrate      # applies it to local D1
bun run db:status
```

Commit the generated SQL. Never edit it by hand — Drizzle records applied
migrations by hash, so an edited file will be re-run.

## 3. Route

`apps/frontend/client/src/routes/`

- `+server.ts` — the API adapter: resolve the caller, validate the body against the
  shared schema, map a service outcome to a status, log the write. No SQL, no
  ownership rule, no budget arithmetic — those live in `#lib/server/` and
  `@starter/*` where a server load and a scheduled run can reach them too. Every
  verb the contract does not have answers 405 rather than leaving a client's
  framework to invent a 404.
- `+page.server.ts` — the server load. It calls the service **directly**;
  `fetch('/api/notes')` from inside the process that serves `/api/notes` is a
  second, differently authenticated path to the same data. It returns DTOs, not
  rows, so no column can leak into page data by accident, and it redirects an
  anonymous request rather than rendering an empty screen that reads as "you have
  none".
- Declare the capability in the load when it is optional. `/jobs` asks
  `locals.container.jobsProfile` before it reads, so a deployment with the feature
  off renders its state from the HTML instead of spending a request on a 503 the
  load already knows the answer to.

## 4. Service

`packages/frontend/features/src/<domain>/<domain>_service.svelte.ts`

Takes an `ApiTransport` in its constructor and never imports one. Validate every
response with `parseDto` against the shared schema — `request<Thing>` compiles
whether the server sent things or an error envelope.

Return typed values and let `AppError` propagate; do not swallow it and return a
fallback, because a ViewModel cannot then tell "the server said no" from "the
network is down".

**Binary needs its own capability.** `request<T>` is a JSON transport — it reads
the body as text and parses it — so an MP4 through it either throws or returns a
truncated string that looks like success. The jobs service takes an
`ArtifactTransport` (`fetchBytes`) instead, so "this host can serve media" is a
compile-time fact.

Do not hold the entity list. It lives in the ViewModel that owns the screen; a
second copy is a second thing that can disagree with the first.

## 5. ViewModel

`packages/frontend/features/src/<domain>/<domain>_view_model.svelte.ts`

Its collaborators — service, `Navigation`, an account service — arrive through the
constructor. No `$app/*` import, no module singleton: a screen that resolves its
own transport cannot be built with a fake.

`$state` for what the view renders. `StaleGuard` for anything async: a superseded
request must be aborted, not merely ignored, or a user typing "a" then "ab" sees
the results for "a" arrive last and win.

`status` is a tagged union — `loading | ready | error` — never a boolean plus a
separate error field, which allows the state where both are set. Add a member when
a state is genuinely different: `JobsStatus` has `unavailable`, because a
deployment with the feature switched off is not an error and must not be rendered
with a retry that cannot work.

**If the screen polls, the loop is part of the ViewModel, with a stop condition.**

- `JobsViewModel` stops on a terminal status, not at a longer interval.
- It backs off with a ceiling, and collapses to the base when a value changes.
- `setActive(false)` drops the timer *and* aborts the request in flight; resuming
  refreshes once.
- Teardown clears the timer, aborts, and releases anything it holds.

The host tells it about visibility (`setActive`) rather than the ViewModel asking,
because "is a window visible" is a host fact. Inject the scheduler too, so
"the timer is not running" is observable and no test sleeps.

## 6. View

A component receives props and raises intents. It holds no logic beyond
formatting, and imports nothing from `apps/backend` (the guard enforces this:
`@starter/ui` in a Worker fails at runtime, not at compile time).

Render only what the contract states. No progress percentage without a numerator,
no queue position, no "estimated remaining". If a number is not in the DTO, it does
not go on the screen — and when a warning must be silenced rather than answered,
say why in the comment above the ignore.

## 7. Tests

In this order of value:

1. **E2E** (`apps/e2e/tests/`) — the path through the real client and Worker.
   Add a cross-account case if the entity is owned: two contexts, and assert the
   row still exists afterwards.
2. **Browser** (`apps/frontend/client/src/browser_tests/`) — reactivity and
   lifecycle through the real Svelte compiler. This is the only lane that can see a
   `$state` write that never reaches the DOM, and it is where Blob revocation and
   abort-on-unmount are proved.
3. **Built Worker** (`apps/frontend/client/tests/worker_integration.test.ts`) — a
   second Worker with the capability **on**, real workerd, real local D1, for
   admission, budgets, ownership and the closed-object refusals.
4. **Unit** (`packages/**/src/**/*.test.ts`) — schema refusals, transport
   classification, pure logic.

Keep the lanes' claims separate. The jobs screen proves its states in a browser
against a disabled profile; the *successful* encode is `bun run test:compute`'s
claim, because it drives the built jobs Worker, real Workflows, real D1 and R2 and
a real FFmpeg container — and that lane has no browser. Two lanes, two claims, no
lane allowed to stand in for the other.

## 8. Docs

Every touched project needs its README updated (the `project-readme` guard checks
the five questions are answered, not that they are current). A feature that adds a
host contract — `ArtifactTransport` — needs its way into the table of what a host
must supply, and a feature with a lifecycle needs the rule written down where the
next author will read it.

## Before you commit

```bash
bun run typecheck && bun run guard && bun run test
```

`bun run guard` is three invariants and a registry check. They have no baselines
and no waivers, so a failure is a real violation, not a ratchet to accept.
---
name: adding-a-feature
description: Use when adding an entity, endpoint or screen to this project — anything that needs a schema, a route, a ViewModel, a service and tests. Covers the order of the work and the conventions that the guards enforce.
---

# Adding a feature

The order matters. Each step depends on the one before it being right, and the
guards fail on convention violations rather than on incomplete features.

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

## 2. Migration

```bash
bun run db:generate     # writes a SQL file
bun run db:migrate      # applies it to local D1
bun run db:status
```

Commit the generated SQL. Never edit it by hand — Drizzle records applied
migrations by hash, so an edited file will be re-run.

## 3. Route

`apps/backend/api/src/lib/<domain>.ts`

- `group('/api/<plural>')` — the `/api` prefix, like every other route here.
  It was once `/notes` while the client called `/api/notes`, and the 404 was
  invisible locally because nothing exercised it.
- Ownership is enforced in the **query**, not after the fetch:
  `where(and(eq(things.id, params.id), eq(things.ownerId, user.id)))`. Returning
  someone else's row and checking afterwards leaks it before you check.
- Declare `response` for each status. A route that returns a shape nothing
  validates will drift from the schema.
- Do not `await` a Drizzle builder with `.then()` — it is both thenable and
  async-iterable, and `.then()` widens the type to a union that no longer matches
  the declared schema.

## 4. Service

`apps/frontend/client/src/lib/services/<domain>_service.svelte.ts`

Wraps `ApiClient`. Return typed values and let `AppError` propagate; do not
swallow it and return a fallback, because a ViewModel cannot then tell "the
server said no" from "the network is down".

## 5. ViewModel

`apps/frontend/client/src/lib/views/<domain>/`

`$state` for what the view renders. `StaleGuard` for anything async: a superseded
request must be aborted, not merely ignored, or a user typing "a" then "ab" sees
the results for "a" arrive last and win.

`status` is a tagged union — `loading | ready | error` — never a boolean plus a
separate error field, which allows the state where both are set.

## 6. View

A component receives props and raises intents. It holds no logic beyond
formatting, and imports nothing from `apps/backend` (the guard enforces this:
`@starter/ui` in a Worker fails at runtime, not at compile time).

## 7. Tests

In this order of value:

1. **E2E** (`apps/e2e/tests/`) — the path through the real client and Worker.
   Add a cross-account case if the entity is owned: two contexts, and assert the
   row still exists afterwards.
2. **Browser** (`apps/frontend/client/src/browser_tests/`) — reactivity and
   lifecycle through the real Svelte compiler.
3. **Unit** (`packages/**/src/**/*.test.ts`) — schema refusals, pure logic.

## Before you commit

```bash
bun run typecheck && bun run guard && bun run test
```

`bun run guard` is three invariants and a registry check. They have no baselines
and no waivers, so a failure is a real violation, not a ratchet to accept.
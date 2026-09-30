# Adding a feature

The order matters. Each step depends on the one before it being right, and the
guards and the linter fail on convention violations rather than on incompleteness.

For an agent, the same content is in `.pi/skills/adding-a-feature/SKILL.md`.

## 1. Schema first

`packages/shared/schemas/src/<domain>/`

One file per entity. The schema is the single source of truth for the client's
type, the Worker's validation, and the database column types.

```ts
export const ThingSchema = Type.Object({
  id: ThingIdSchema,
  ownerId: UserIdSchema,           // ownership is almost always present
  name: Type.String({ minLength: 1, maxLength: 120 }),
  createdAt: Type.Number(),         // epoch milliseconds
}, { additionalProperties: false });
export type Thing = Static<typeof ThingSchema>;
```

`additionalProperties: false` on every object. It is what makes `Value.Check` a
refusal rather than a coercion mechanism: without it an unknown field is silently
dropped, and the client is told the write succeeded.

Derive create and update schemas separately:

```ts
export const ThingCreateSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
}, { additionalProperties: false });

export const ThingUpdateSchema = Type.Object({
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
}, { additionalProperties: false, minProperties: 1 });
```

`ThingCreateSchema` must not accept `ownerId`. Ownership comes from the session,
never from the body — a body carrying one is a request to write into another
account's list.

`minProperties: 1` on the update schema refuses an empty PATCH, which otherwise
costs a round trip and a row write to change nothing.

Add a `validateThingInput` alongside when the client should show a message without
a round trip. Keep it in step with the schema, and add the test that asserts they
agree — see step 7.

## 2. Migration

```bash
bun run db:generate     # writes SQL into packages/backend/database/drizzle-d1
bun run db:migrate      # applies to local D1
bun run db:status
```

Commit the generated SQL. Never edit it by hand: Drizzle records applied
migrations by hash, so an edited file is applied a second time.

## 3. Route

`apps/backend/api/src/lib/<domain>.ts`

```ts
export const thingRoutes = (container: Container) =>
  new Elysia({ name: 'starter/things' }).group('/api/things', (group) =>
    group
      .get('/', async ({ request }) => {
        const { user } = await buildRequestContext(request, container);
        if (!user) return unauthorized();

        const rows = await container.db
          .select().from(things)
          .where(eq(things.ownerId, user.id))
          .orderBy(desc(things.updatedAt))
          .limit(200);

        return { things: rows.map(toWireThing), serverTime: Date.now() };
      }, { response: { 200: ThingListSchema, 401: errorBody } }),
  );
```

Four things to copy:

- **`group('/api/...')`** — the `/api` prefix, like every other route. It was once
  `/notes` while the client called `/api/notes`, and the 404 was invisible locally
  because nothing exercised it.
- **Ownership in the query.** `where(and(eq(things.id, params.id), eq(things.ownerId, user.id)))`.
  A row fetched and then checked has already been returned to code that can log it.
- **Declare `response` per status.** A route returning a shape nothing validates
  will drift from the schema.
- **`await` the Drizzle builder.** It is both thenable and async-iterable, so
  `.then()` widens the result to a union that no longer matches the declared
  response schema.

Register the group in `apps/backend/api/src/index.ts` **before** the auth mount.
The mount must stay last: `.mount()` on a plain function drops every route
registered after it.

## 4. Service

`apps/frontend/client/src/lib/services/<domain>_service.svelte.ts`

```ts
export class ThingService extends BaseClass {
  readonly #api: ApiClient;
  constructor(options: { api: ApiClient; className?: string }) { /* ... */ }

  async list(signal?: AbortSignal): Promise<Thing[]> {
    return await this.#api.get<ThingList>('/api/things', { signal }).then((r) => r.things);
  }
}
```

Return typed values and let `AppError` propagate. Do not catch it and return a
fallback — a ViewModel cannot then tell "the server said no" from "the network is
down", and both render as an empty list.

## 5. ViewModel

`apps/frontend/client/src/lib/views/<domain>/`

```ts
export class ThingViewModel extends BaseClass {
  status = $state<Status>({ kind: 'loading' });   // loading | ready | error
  #guard = new StaleGuard();

  async load(): Promise<void> {
    const operation = this.#guard.begin();
    try {
      const things = await this.#service.list(operation.signal);
      if (!this.#guard.isCurrent(operation.token)) return;   // a newer load won
      this.status = { kind: 'ready', things };
    } catch (error) {
      if (isAbortError(error)) return;                       // not a failure
      this.status = { kind: 'error', message: ..., retryable: true };
    }
  }
}
```

Three rules:

- `StaleGuard` for anything async. Both checks matter: the signal actually
  cancels the request, and `isCurrent` stops a resolved-but-superseded promise
  from writing.
- An abort is not an error. Returning early on `isAbortError` is what keeps a user
  from seeing a failure caused by their own typing.
- `dispose()` calls `this.#guard.cancelAll()`, so a torn-down screen cannot be
  written to.

## 6. View

A component receives props and raises intents. It holds no logic beyond
formatting, and imports nothing from `apps/backend` — `@starter/ui` in a Worker
compiles and then fails, or drags `svelte/internal` into a bundle with no DOM.

Compose it in a `*_composition.ts` next to the ViewModel, so the wiring is in one
place and a test can construct the ViewModel without mounting anything.

## 7. Tests

In order of value:

1. **E2E** (`apps/e2e/tests/`) — the path through the built client and a real
   Worker. If the entity is owned, add a cross-account case: two separate browser
   contexts, and assert the row still exists afterwards, so a `403` from a handler
   that deleted it anyway would fail.
2. **Browser** (`apps/frontend/client/src/browser_tests/`) — reactivity and
   lifecycle through the real Svelte compiler. This is the only lane that can catch
   a `$state` write that does not reach the DOM.
3. **Unit** (`packages/**/src/**/*.test.ts`) — schema refusals, pure logic.

If you added `validateThingInput`, add the test that asserts the client and the
schema agree on every case. Without it they drift, and the symptom is a form that
shows no error for a request the Worker rejects.

## 8. Before you commit

```bash
bun run typecheck
bun run guard
bun run lint
bun run test
```

`bun run guard` is five invariants with no baselines and no waivers. A failure is
a real violation, not a ratchet to accept.

For a change that changes what "done" means, write a contract first:

```bash
bun run contract new "Add thing export as NDJSON" --mode standard
```

See `docs/contracts/THIN_TEMPLATE.md` for the shape, and
[architecture.md](architecture.md) for why the boundaries it mentions are where
they are.
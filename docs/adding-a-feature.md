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

## 3. Server service

`apps/frontend/client/src/lib/server/<domain>_service.ts`

The queries live here, in the Worker half of the one application. Nothing under
`src/lib/server/` may be imported by a component or a client service, and
`bun run guard` and Biome both enforce that.

```ts
export const listThings = async (db: NotesDatabase, userId: string): Promise<Thing[]> => {
  const rows = await db
    .select()
    .from(things)
    .where(eq(things.ownerId, userId))
    .orderBy(desc(things.updatedAt))
    .limit(200);

  return rows.map(toWireThing);
};
```

Two things to copy:

- **Ownership in the query.** `where(and(eq(things.id, params.id), eq(things.ownerId, userId)))`.
  A row fetched and then checked has already been returned to code that can log it.
  The function takes the *user id* as an argument rather than reading it from a
  module: a Worker isolate serves many concurrent requests, and a module-level
  identity is a cross-request data leak. See [architecture.md](architecture.md).
- **`toWire*`.** The service returns the wire DTO, never a database row, so a caller
  cannot serialize an internal column into a response.

## 4. Route

`apps/frontend/client/src/routes/api/things/+server.ts`

The route is a thin adapter: resolve identity, validate the body, call the service,
map a result to a status.

```ts
import type { RequestHandler } from './$types';
import { json, readJsonBody, unauthorized } from '#lib/server/http.ts';
import { createThingsService } from '#lib/server/things_service.ts';

export const GET: RequestHandler = async ({ locals }) => {
  const user = locals.user;
  if (user === null) {
    return unauthorized();
  }

  const things = await createThingsService(locals.container.db).list(user.id);
  return json(200, { things });
};
```

Five things to copy:

- **The `/api` prefix is the directory name**, like every other route, so an
  unmatched `/api/*` becomes a JSON 404 from `hooks.server.ts` rather than
  SvelteKit's HTML error page.
- **`locals.user`, resolved by the composition root.** Do not call
  `buildRequestContext` on the read path — it would resolve the same session twice.
  The write paths do build a context, because a write is the event worth logging.
- **Validate the body with `readJsonBody` against the shared schema**, with a
  `maxBytes` bound. `additionalProperties: false` then makes an unknown field a
  refusal rather than a silent drop.
- **Return the same `{ error, message }` shape for every refusal**, from
  `#lib/server/http.ts`. A client cannot handle two error shapes.
- **Declare the unsupported verbs.** A `PUT` that returns
  `jsonError(405, 'method_not_allowed', …)` beats a framework 405 page.

A `+page.server.ts` for a server-rendered page calls the service directly the same
way — `notes/+page.server.ts` is the worked example. It never fetches its own
origin: a round-trip to `/api/notes` from inside the process that serves
`/api/notes` is a second, differently-authenticated path to the same data, and it
works in development and fails in production for different reasons.

## 5. Client service

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

## 6. ViewModel

`apps/frontend/client/src/lib/features/<domain>/`

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

## 7. View

A component receives props and raises intents. It holds no logic beyond
formatting, and imports nothing from `@starter/ui` — Svelte components in a Worker
compile and then fail, or drag `svelte/internal` into a bundle with no DOM. Both
Biome and `bun run guard` refuse it.

Compose it in a `*_composition.ts` next to the ViewModel, so the wiring is in one
place and a test can construct the ViewModel without mounting anything.

## 8. Tests

In order of value:

1. **E2E** (`apps/e2e/tests/`) — the path through the built client and a real
   Worker. If the entity is owned, add a cross-account case: two separate browser
   contexts, and assert the row still exists afterwards, so a `403` from a handler
   that deleted it anyway would fail.
2. **Browser** (`apps/frontend/client/src/browser_tests/`) — reactivity and
   lifecycle through the real Svelte compiler. This is the only lane that can catch
   a `$state` write that does not reach the DOM.
3. **Worker** (`apps/frontend/client/tests/worker_integration.test.ts`) — the route
   over real workerd and real D1: ownership denial, oversized bodies, the JSON 404
   shape. This is the lane that catches a query that compiles and returns the wrong
   rows.
4. **Unit** (`packages/**/src/**/*.test.ts`, `scripts/tests/**`) — schema refusals,
   pure logic, plans and refusals.

If you added `validateThingInput`, add the test that asserts the client and the
schema agree on every case. Without it they drift, and the symptom is a form that
shows no error for a request the Worker rejects.

## 9. Before you commit

```bash
bun run typecheck
bun run guard
bun run lint
bun run format
bun run test
bun run test:worker
bun run e2e
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
# @starter/utils

Portable, dependency-light primitives. This is the bottom of the dependency
graph: it imports `@starter/logger` and `@starter/schemas` and nothing else, and
no project in the workspace may import it *into* `shared`.

That constraint is the point. Anything here runs in a Worker, a browser, and a
Tauri webview, so an import of `drizzle-orm` or `node:fs` would be either dead
code in two of those places or a runtime failure in the third.

## What is here

| Module | What it is for |
|---|---|
| `BaseClass` | The one base class for anything with a lifecycle |
| `StaleGuard` | Stops a superseded async response overwriting a newer one |
| `createObserver` / `createLiteObserver` | Subscription primitives, owned by their creator |
| `AppError` | A classified error, so callers branch on data rather than status codes |
| `createDeferred` | A promise with its `resolve`/`reject` exposed |
| `slugify` / `previewText` | Total, deterministic text helpers |

## The two that carry the weight

### `BaseClass`

One canonical construction path via `BaseClass.create()`. It gives every instance
a name for logging and applies dev-only method tracing.

In development it shadows prototype methods on the **instance**, not through a
`Proxy`. A `Proxy` in front of an instance breaks Svelte 5 `$state` and native `#`
private fields, and the instance is handed straight to a reactive graph. A test
that only checks "does calling a method log?" passes under either implementation;
only `#private` field access tells them apart.

### `StaleGuard`

Prevents the most common correctness bug in a ViewModel UI: a user searches "a",
then "ab", and the "a" response arrives last and clobbers the "ab" results.

It does two things at once, which is why it is one object rather than two pieces
of bookkeeping the caller has to keep in sync — a monotonically increasing token
checked with `isCurrent()`, and an `AbortSignal` per operation, so the superseded
request is actually cancelled rather than merely ignored.

```ts
const operation = this.#guard.begin();
const things = await this.#service.list(operation.signal);
if (!this.#guard.isCurrent(operation.token)) return;   // a newer load won
```

Ignoring is not enough: an ignored request still occupies a connection and still
costs server work.

## Tasks

```bash
bun run typecheck
bun run lint
bun run format
bun run fix
bun run test
```

## See also

- [architecture.md](../../docs/architecture.md) — why the layer boundaries are
  where they are
- [testing.md](../../docs/testing.md) — why `BaseClass`'s tracing is tested
  against `#private` field access specifically
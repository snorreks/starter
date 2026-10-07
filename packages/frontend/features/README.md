# @starter/features

The screens more than one host renders: the notes screen, the reusable half of the
account screen, and the sample-encode screen.

## Purpose and runtime

`browser`-plane modules (`scripts/src/guards/policy.ts`). They load in a browser,
in the SSR application's browser half and in a static SvelteKit bundle, and under
Bun for the unit lane. They never run in workerd.

The architecture is the same one the web application already used, now in a
package instead of a directory:

```
routes/**            composition — construct a ViewModel, render a View
  └─ View            markup, accessibility, raised intents
      └─ ViewModel   screen state and the commands a view raises
          └─ service transport, over an injected ApiTransport
```

`bun run guard` classifies each file here by that shape (`view`, `view-model`,
`service`, `composition`) and refuses the inversions — a View importing a service,
a service importing a ViewModel — in this package exactly as it does in the
application. That is what stops the extraction from becoming a hole in the
architecture.

## Setup and configuration

Nothing to configure. Three host answers are required and none of them is a
default:

| Contract | Supplied by the host | Web answer today |
|---|---|---|
| `ApiTransport` | the HTTP seam | `lib/composition/transport.ts` — same-origin, `credentials: 'include'` |
| `ArtifactTransport` | the byte seam, for media | the same `HttpTransport` instance — JSON and bytes in one place |
| `Navigation` | how the host moves | `lib/composition/session.ts` — `invalidateAll()` then `goto` |
| `AuthSession` + `AccountService` | credentials and mail endpoints | the same file, over the web transport |

A feature that needs a host fact the contracts do not cover does not import the
host. It declares what it needs, and the host answers. That is the entire reason
`AuthView` takes a `progressive` boolean instead of knowing about SvelteKit form
actions.

`ArtifactTransport` is a separate type from `ApiTransport` because
`request<T>` is a **JSON** transport: it reads the body as text and parses it.
Pointed at an MP4 it throws, or worse, hands back a truncated string that looks
like a successful answer. Asking for bytes is therefore a distinct capability, so a
host that cannot serve one cannot construct the feature that needs it — a compile
error instead of a runtime surprise.

## The jobs feature, in one worked example

The most instructive feature here, because it is the one with a lifecycle rather
than a form. `src/jobs/`:

| File | Role |
|---|---|
| `jobs_service.svelte.ts` | three endpoints, each answer validated with `parseDto`; `readOutput` goes through the byte seam |
| `jobs_output.ts` | turns authenticated bytes into one owned, revocable Blob |
| `jobs_view_model.svelte.ts` | the poll loop, the refusals, the held result |
| `jobs_view.svelte`, `job_row.svelte` | markup, accessibility, no invented metrics |

Five rules it exists to enforce, each with a control behind it:

1. **It stops polling when it can learn nothing.** A `succeeded` or `failed` row is
   never written again, so the loop stops entirely — no timer, not a longer one.
2. **It backs off, and collapses on a change.** 1.5 s doubling to 20 s while
   nothing moves; back to 1.5 s the moment a job's `updatedAt` does.
3. **It stops when nobody is looking.** `setActive(false)` drops the timer *and*
   aborts the request in flight; resuming refreshes once rather than trusting a
   list that missed every transition.
4. **A stale answer cannot win.** `StaleGuard` decides which of two overlapping
   reads may write, and a terminal row is never walked back to `running`.
5. **No credential is ever in a URL.** The result is fetched through the transport
   — cookie in the browser, bearer header in a shell — and becomes a Blob that
   `dispose()` revokes. A pinned Blob is an encoded video held for the session.

Three things it deliberately refuses to render: a progress percentage (the job
contract has no numerator), a queue position, and a single "last maintenance run"
that would report a hand-triggered sweep as the schedule firing.

`apps/frontend/client/src/routes/jobs/+page.server.ts` and
`apps/frontend/native/src/routes/jobs/+page.svelte` are the two route halves, and
they are as thin as the notes ones.

## Commands

All run from `packages/frontend/features`; the root `bun run <name>` reaches the
same script through Moon.

```bash
bun run typecheck   # svelte-check, threshold error
bun run lint        # biome
bun run format      # biome, verified not applied
bun run fix         # biome --write
bun run test        # bun test
```

## Validation and artifacts

`bun run test` is the lane, and its defining property is that it needs **no
application runtime**: `notes_service.test.ts`, `account_service.test.ts` and
`jobs_service.test.ts` construct their collaborators from fakes and nothing from
`apps/` is resolvable there. `notes_view_model.test.ts` carries the mutation
lifecycle controls — disposal, overlapping optimistic deletes, duplicate
submissions — that moved here unchanged, and `jobs_view_model.test.ts` carries the
poll lifecycle: base interval, bounded backoff, terminal stop, backgrounded stop,
stale answers and Blob revocation. It injects its own `Scheduler`, so "the timer is
not running" is observable and no assertion waits on wall time.

The reactive half is proved in the web application's browser lane
(`apps/frontend/client/src/browser_tests/`), which mounts these same components
with the real Svelte compiler in Chromium; `apps/e2e` drives them through the
built SSR Worker. Both are named in [docs/testing.md](../../../docs/testing.md).

## Boundaries

May import `@starter/platform`, `@starter/schemas`, `@starter/ui`, `@starter/utils`
and Valibot. May **not** import:

- `$app/*`, `@sveltejs/kit` — the router is injected as `Navigation`
- `@tauri-apps/*` — that is a native composition root's `native-bridge` role
- `@starter/database`, `@starter/auth`, `drizzle-orm`, `better-auth` — server
  implementation, refused by Biome's frontend override
- `apps/**`, `scripts/**` — including by relative path: a package reaches an
  application through a published export or not at all

Progressive enhancement, the form actions behind this application's sign-in,
forgot-password, reset-password and verify-email screens, their origin and rate
checks, and the SSR redirects all stay in
`apps/frontend/client/src/routes/**`, where the server plane can reach them. A
native shell has no form actions and is not given a component that pretends to.
See [docs/architecture.md](../../../docs/architecture.md).

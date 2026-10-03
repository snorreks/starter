# @starter/features

The screens more than one host renders: the notes screen, and the reusable half of
the account screen.

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
| `Navigation` | how the host moves | `lib/composition/session.ts` — `invalidateAll()` then `goto` |
| `AuthSession` + `AccountService` | credentials and mail endpoints | the same file, over the web transport |

A feature that needs a host fact the contracts do not cover does not import the
host. It declares what it needs, and the host answers. That is the entire reason
`AuthView` takes a `progressive` boolean instead of knowing about SvelteKit form
actions.

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
application runtime**: `notes_service.test.ts` and `account_service.test.ts`
construct their collaborators from fakes and nothing from `apps/` is resolvable
there. `notes_view_model.test.ts` carries the mutation lifecycle controls —
disposal, overlapping optimistic deletes, duplicate submissions — that moved here
unchanged.

The reactive half is proved in the web application's browser lane
(`apps/frontend/client/src/browser_tests/`), which mounts these same components
with the real Svelte compiler in Chromium; `apps/e2e` drives them through the
built SSR Worker. Both are named in [docs/testing.md](../../../docs/testing.md).

## Boundaries

May import `@starter/platform`, `@starter/schemas`, `@starter/ui`, `@starter/utils`
and TypeBox. May **not** import:

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
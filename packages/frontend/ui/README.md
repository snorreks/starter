# @starter/ui

Browser presentation components and the design tokens that go with them.

## Purpose and runtime

Svelte 5 components used by the web app and, from here on, by the native app
too. They run in a browser, never in workerd and never under Bun — they are
`browser`-plane modules in `scripts/src/guards/policy.ts`, which is what lets
Biome and `bun run guard` keep them out of the Worker bundle.

There is no state, no transport and no screen logic here. A component takes props
and raises intents; the ViewModel that owns the screen owns everything else.

## Setup and configuration

Nothing to configure. The tokens are plain CSS custom properties in
`src/tokens.css`, published as the `./tokens.css` subpath so a consumer imports
one file rather than re-declaring the palette:

```css
@import '@starter/ui/tokens.css';
```

The peer dependency on `svelte` is declared in `package.json`, and the project is
a Moon `library` that depends on `schemas` and `utils` for the build order.

## Commands

All of these run from `packages/frontend/ui`; the root `bun run <name>` invokes
the same script through Moon.

```bash
bun run typecheck   # svelte-check, threshold error
bun run lint        # biome
bun run format      # biome, verified not applied
bun run fix         # biome --write
bun run test        # bun test
```

## Tests and artifacts

`bun test --pass-with-no-tests`: this project currently has no test file of its
own, and it says so out loud rather than reporting a green run that asserted
nothing. Adding the first test means removing that flag, so an empty project
cannot quietly become an untested one.

Its behaviour is covered from the outside instead — `@starter/ui`'s components are
rendered by the browser lane in `apps/frontend/client` and driven through the E2E
suite. The artifact is a component library: no build step, no emitted bundle, the
`svelte` field in `package.json` is the deliverable.

## Boundaries and documentation

May import `@starter/schemas` and `@starter/utils`. May not import an
application, a server package, or anything from `src/lib/server/**` — the guard
reports that as `plane-reachability`, not as a lint warning.

Published subpaths: `.` (the barrel), `./screen`, `./feedback`, `./tokens.css`.
Import the subpath, not a deep path into `src/`.

- [docs/architecture.md](../../../docs/architecture.md) — the plane this package is on
- [docs/lint.md](../../../docs/lint.md) — the import rules Biome enforces here
- [docs/adding-a-feature.md](../../../docs/adding-a-feature.md) — where a new component belongs

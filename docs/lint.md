# Linting

Biome is the only linter and formatter in this repository.

```bash
bun run lint     # biome lint
bun run format   # biome format
bun run fix      # biome check --write, plus formatting
```

## Two rules are off, and why

Both are off because they cannot be satisfied honestly here. Neither was turned
off to make a failing check pass.

### `useFilenamingConvention`

Biome parses `playwright.config.ts` as having the **extension** `config.ts`, and
neither `filenameCases` nor a `match` regex makes that parse as a valid
extension. The rule can only be satisfied by not having files of that shape — and
every SvelteKit and Playwright project has them.

The convention this rule was reaching for (`snake_case`, no camelCase) is real and
is enforced in review instead.

### `useNamingConvention`

Its built-in camelCase default for object keys **cannot be relaxed**. Adding a
convention for a selector does not replace the default; it adds to it, and both
then fire.

This project has legitimate `SCREAMING_SNAKE_CASE` object keys:

- Cloudflare binding names — `DB` in `Cloudflare.Env` and `App.Platform`. These are
  the platform's API. Renaming them breaks the deployment.
- Environment variable names — `TRUSTED_ORIGINS`, `AUTH_RATE_LIMIT_MAX`.

Neither is a naming mistake, so the rule has nothing useful to say here.

## Two runtimes, two override sets

`apps/frontend/client` holds a browser half and a Worker half, so `biome.json` draws
the server plane in two places rather than one:

| Override | Covers | Denies |
|---|---|---|
| server plane | `packages/backend/**`, `scripts/**` | Svelte, `@sveltejs/kit`, `@sveltejs/vite-plugin-svelte`, the frontend packages, and the DOM globals |
| server half of the app | `src/lib/server/**`, `src/hooks.server.ts`, `src/routes/**/+server.ts`, `+page.server.ts`, `+layout.server.ts` | Svelte's client runtime, the Vite plugin, the frontend packages, and the DOM globals |
| browser half of the app | `packages/frontend/**` and the rest of `apps/frontend/**` | `node:*`/`bun:*`, `@starter/database`, `@starter/auth`, `drizzle-orm`, `better-auth`, and `Bun` |

The app's server override deliberately does **not** deny `@sveltejs/kit`. The Worker
half *is* SvelteKit — `error`, `redirect`, `json`, `Handle` — so denying the
framework there would deny the framework. What it denies is Svelte's client runtime,
which compiles for a DOM that workerd does not have.

The browser override lists the server shapes as negative includes, because Biome
applies overrides in order and the last match wins; without the exclusions the
browser rules would re-deny `@starter/database` in `notes_service.ts` one file after
the server override allowed it.

`bun run guard` enforces the same boundary from the *other* side, by recognising
the same five path shapes. Two independent mechanisms on one rule is deliberate — see
[architecture.md](architecture.md).

## Scoped exemptions

Each is a file whose purpose is to violate the rule it would trip.

| File | Rule | Why |
|---|---|---|
| `packages/shared/logger/src/lib/console_logger.ts` | `noConsole` | This is the logger's console backend. The rule exists to stop ad-hoc console calls in favour of the logger. |
| `scripts/src/guards/**/*.ts` | `useBlockStatements`, `useConsistentTypeDefinitions` | The guards contain the literal patterns they search for. A guard that failed on its own source would never report anything. `guardNoLeftovers` already exempts them for the same reason. |
| `apps/frontend/client/src/lib/test_setup.ts` | `noConsole`, `noRestrictedImports` | The Bun unit lane's preload. It mocks `bun:test` and silences the logger — both are the file's job. |
| `apps/frontend/client/src/lib/server/container.ts` | `useConsistentTypeDefinitions` | `DrizzleD1Database<T>` constrains `T` to `Record<string, unknown>`, and an interface has no implicit index signature. This one is a type error, not a preference. |
| `**/*.svelte` | `noUnusedVariables`, `noUnusedImports` | Biome does not resolve Svelte 5's `$props()` destructuring, so every prop and every component import reads as unused. Running its autofix over these files **deletes live imports**. |
| `**/*.svelte` | `useConsistentTypeDefinitions` | `interface Props` is the form every Svelte 5 codebase writes. Converting nine declarations would make the components less recognisable for no gain. |
| two files (listed in `biome.json`) | `noConsole` | One `console.info` each, with the reason in a comment at the call site. |

The `.svelte` exemption is the one to watch. If you add a component and see
"unused import", check the template before you delete the import — it is almost
certainly being used.

## What is still enforced

The overrides that remain carry the architectural weight:

- **`noRestrictedGlobals`** — `window`, `document`, `localStorage`,
  `sessionStorage` and `navigator` are denied in both server planes; `Bun` is denied
  in the browser plane. Each denial carries the reason, which Biome prints on
  violation.
- **`noRestrictedImports`** — neither server plane may import the frontend packages;
  the browser plane may not import the database, auth, `drizzle-orm`, `better-auth`,
  or `node:*`/`bun:*`.
- **`noExplicitAny`**, **`noNonNullAssertion`**, **`noParameterAssign`**,
  **`noConsole`** outside the exemptions.

`bun run guard` enforces the same boundaries at runtime and additionally covers
things a linter cannot see: module-level request state, gitignored source, and
registry self-consistency. The linter and the guards are not redundant — Biome
cannot parse import graphs for a Worker, and the guards cannot see a `// TODO`
sitting in a comment.

## Migrating from Biome 1.x

This configuration was written for Biome 1.x and did not run: six keys were
invalid under 2.5, and a single unknown key fails the whole file. The migration
was mechanical:

| Was | Now |
|---|---|
| `noReassign` | removed (not a Biome rule) |
| `options: { style: "shorthand" }` | `options: { syntax: "shorthand" }` |
| `options: { style: "type" }` | no options at all |
| `useFilenamingConvention: { ignore: [...] }` | rule disabled; see above |
| `leadingUnderscore: "require"` | rule disabled; see above |
| `noRestrictedGlobals` under `correctness` | under `style` |
| `options: { globals: [...] }` | `options: { deniedGlobals: { name: "reason" } }` |

**If you upgrade Biome, run `bun run lint` first.** A config that fails to
deserialize reports nothing about your code, which reads exactly like "no lint
problems".
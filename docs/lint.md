# Linting

Biome is the only linter and formatter in this repository.

```bash
bun run lint     # biome lint
bun run format   # biome format
bun run fix      # biome check --write, plus formatting
```

## What repository-wide source checks discover

`scripts/src/guards/policy.ts` owns the maintained source roots: `apps/`,
`packages/`, `scripts/`, and `.pi/`. Architecture, debug-leftover and hidden-source
checks scan these roots, not arbitrary repository scratch files. Cargo discovery
uses the same roots. A new application is still reported as unclassified until its
runtime is deliberately assigned; ignored first-party source still fails.

Root configuration, declared workspace projects, documentation and workflows are
checked through their explicit inputs. They are not discovered by scanning a
scratch directory. A directory named `tmp` **inside an application's source tree**
is still source; only repository-level scratch is outside the governed roots.

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

`bun run guard` enforces the same boundary from the *other* side, and the two are not
redundant. Biome reads an import statement as written: it is fast, it runs in the
editor, and it knows why a given specifier is banned in a given directory. The guard
resolves the graph — every specifier through the owning project's `tsconfig.json` and
each package's `exports` map — and checks reachability, so it sees through re-exports,
relative traversal and aliases that Biome reads as an ordinary local import. See
[architecture.md](architecture.md) for the five files and the seventeen rules, including
the cases the guard deliberately does not claim.

Biome's `noRestrictedImports` denies `node:*`/`bun:*` in the browser half. The guard
checks the same fact by capability, which additionally covers a Node-only helper reached
through a portable package's declared subpath — a statement Biome cannot see and
`node:*` matching would miss, because the specifier is not a Node built-in.

## One runtime strips TypeScript and cannot transform it

`bun run dev` and `vite preview` run the SSR half in **Node**, which loads the
TypeScript **source** of every workspace package — each `exports` entry points at
`.ts`, so there is no build step in front of Node. Node 22 removes type annotations
and leaves everything else alone. Three constructs need a *transform* rather than an
erasure, and Node refuses all three with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`, as a
runtime error on every request rather than as a build or type error:

| Rule | Construct |
|---|---|
| `noParameterProperties` | `constructor(private readonly x: T)` — the assignment is generated code |
| `noEnum` | `enum`, which compiles to an object plus a variable |
| `noNamespace` | `namespace`, which compiles to a function plus a variable |

All three are `error` for every source file, with two exemptions:

| Exempt | Why |
|---|---|
| `scripts/**`, `.pi/**` | Only Bun ever loads these. Bun transforms, so the constructs are correct there; rewriting four call sites to satisfy a runtime that does not read them would be a rule with no failure behind it. |
| `**/*.d.ts` | Never evaluated. SvelteKit requires `declare namespace App` in `apps/frontend/client/src/app.d.ts`, and denying the ambient declaration the framework mandates would be a rule against the framework. |

This is not a style preference. `packages/shared/utils/src/lib/common/base_class.ts`
carried a parameter property for long enough that `bun run dev` answered every
request with a 500 while the unit, Worker and E2E lanes stayed green — the syntax is
only reached by the Node runtime, which is why no other check saw it. The
declaration-plus-assignment form the rule asks for is the same semantics in syntax
both Node and a bundler accept:

```ts
// refused by Node's strip-only mode
constructor(protected readonly options: Options) {}

// accepted, identical semantics
protected readonly options: Options;

constructor(options: Options) {
  this.options = options;
}
```

## Scoped exemptions

Each is a file whose purpose is to violate the rule it would trip.

| File | Rule | Why |
|---|---|---|
| `packages/shared/logger/src/lib/console_logger.ts` | `noConsole` | This is the logger's console backend. The rule exists to stop ad-hoc console calls in favour of the logger. |
| `scripts/src/guards/**/*.ts` | `useBlockStatements`, `useConsistentTypeDefinitions` | The guards contain the literal patterns they search for, and a table of the specifiers they resolve. A guard that failed on its own source would never report anything. `guardNoLeftovers` already exempts them for the same reason. |
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
- **`noParameterProperties`**, **`noEnum`**, **`noNamespace`** outside the two
  exemptions above, because Node's strip-only mode cannot load them.

`bun run guard` adds what a linter cannot see: module-level request state, gitignored
source, registry self-consistency, and the resolved module graph. The two are not
redundant — Biome cannot resolve a `@starter/utils/process` import to discover that it
opens a subprocess, and the guard does not know that a component's markup mentions
`window`.

## The eight guards

`bun run guard` runs all of them over the whole repository. There is no baseline and
no waiver file: a guard that fails is a defect, not debt.

| Id | What it refuses |
|---|---|
| `architecture` | Anything the resolved module graph cannot account for: an unclassified source file, an unresolved specifier, a plane reaching a plane it may not, a feature layer imported backwards, a package imported without its `exports` or its declaration, a relative path leaving its workspace |
| `request-state` | Module-level mutable request state |
| `no-leftovers` | `console.log`, `debugger`, `TODO(remove)` in production source |
| `source-is-tracked` | A source file `.gitignore` excludes |
| `registry-valid` | A resource id or worker name committed as a literal |
| `version-mirrors` | A pin file that disagrees with `config/toolchain.json` |
| `documented-paths` | A document pointing at a path or link that does not exist |
| `project-readme` | A first-party project with no README, or one that answers none of the five required questions |

### The roots the policy already classifies

Four roots are classified in `scripts/src/guards/policy.ts` before they contain a
file, because a rule that arrives with the first file in a directory is a rule nobody
reviewed:

| Root | Plane | Role that is not the default |
|---|---|---|
| `packages/frontend/features/**` | `browser` | The View / ViewModel / service layers, decided by name exactly as the web app's own feature directory used to decide them — one pattern covers both, so a file cannot be a View in the package and a plain module in the app |
| `packages/frontend/platform/**` | `browser` | None. Contracts and injected transports; no screen state, so no feature role is claimed |
| `apps/frontend/native/**` | `browser` under `src/`, `node` elsewhere | `src/lib/platform/**` is `native-bridge` — the only place `@tauri-apps/*` may appear |
| `apps/backend/jobs/**` | `worker` | None yet |

Two consequences worth stating, because both are the reason the table is per-path
rather than per-directory:

- The backend application root has **no** blanket entry. A second application placed
  under it is reported as `unclassified-source` until somebody says what runtime it
  has.
- The Tauri API is **not** added to the browser plane's capabilities. `CAPABILITY_ROLES`
  confines `native-runtime` to the `native-bridge` role, so a component beside the
  bridge that imports `@tauri-apps/api/core` is refused even though both files are
  `browser`-plane files in the same application.

Rust is not in the graph at all: `SOURCE_EXTENSIONS` is `.ts`, `.tsx`, `.svelte`. A
crate is discovered as a *project* — it owes a README — and its source is validated by
`cargo check` and `cargo test` in its own lane.

### Cross-workspace relative imports

`../../scripts/src/shared/paths.ts` is not a package specifier, so it skipped both the
`exports` check and the declared-dependency check at once. That is now
`cross-workspace-relative-import`, with the dependency chain and the remedy — publish
the subpath, declare the dependency, import by name — in the message.

Two exemptions exist, each naming why, and both are checked for staleness: delete the
last import that uses a row and the guard reports the row.

| Pair | Why |
|---|---|
| `apps/e2e` -> `scripts` | The Playwright harness and the tooling it configures are one Bun process |
| `apps/frontend/client` -> `scripts` | The Vitest config resolves the browser executable before any application module loads, in Node |

Type-only relative imports are exempt, and the reason is written down rather than
implied: TypeScript erases the declaration, so it cannot put a module into a bundle.
The compile-time coupling it does create is owned by the server-type-only rule.

### What counts as a project

The README guard discovers its obligations from the repository's own declarations —
the root manifest's `workspaces` globs, `.moon/workspace.yml`, and every first-party
`Cargo.toml` — and never from a list. Generated and vendored trees are excluded by
one policy (`GENERATED_TREES`), so `src-tauri/gen/android`, `.moon/cache` and
`node_modules` are not projects, while the crate that generates them still is.

A README owes five answers, matched against headings rather than a template: purpose
and runtime, setup and configuration, commands with their working directory, what
validates it and what it produces, and its boundaries with links to the canonical
guides. The wording is free; the answers are not.

### How long it takes, and why it is not cached

```
bun run scripts/src/cli.ts guard --profile
```

Measured on the development machine over this repository, three consecutive runs:

| Guard | ms |
|---|---|
| `architecture` | 881 / 894 / 1020 |
| the other seven, summed | 56 / 65 / 68 |
| total | 937 / 952 / 1081 |

That is the whole cost of the guard lane, in a static job that also runs a full
typecheck and lint. It is deliberately uncached: a cached result is only as fresh as a
key that would have to include every tsconfig `paths` entry, every `exports` map and
every alias, and Moon 2.6.0 already demonstrated in this repository what a key built
from the files a task can see is worth. `--affected` is not used either, for the same
reason: a wrong skip is invisible, because the lane goes green without having looked.

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
| `"recommended": true` (root and every group) | `"preset": "recommended"` — 2.5.13 renamed the key and reports the old one as a `deserialize` info on every run |

The `preset` rename is a drop-in only because `PresetConfig` is the enum
`recommended | all | none`, and every group here used `recommended`. That is a claim
about *this* config, so it was measured rather than assumed: the same probe file,
linted against the old config and the new one, reports the **same eleven rules** —
three `noConsole`, and one each of `useIterableCallbackReturn`, `noExplicitAny`,
`noParameterProperties`, `noNonNullAssertion`, `noNestedTernary`, `noNamespace`,
`noEnum`, `useArrowFunction`, `noForEach` — plus the same two explicitly-configured
rules (`useLiteralKeys`, `noDelete`). "Zero diagnostics" is also what a config that
silently disabled every rule would print, which is the whole reason the probe exists.

**If you upgrade Biome, run `bun run lint` first.** A config that fails to
deserialize reports nothing about your code, which reads exactly like "no lint
problems".

## The whole repository is formatted, and one tree is not ours to format

`biome.json` claims `**`, so `biome format .` and `biome lint .` at the root cover
every tracked file — `biome.json`, `config/toolchain.json`, `docs/evidence/current.json`,
every `package.json`, `tsconfig.json`, `wrangler.jsonc` and the Tauri capability file, not
only the `src/` and `tests/` the per-project `format` tasks reach. That was not true for
a while: twenty-two committed files sat outside any `format` task and drifted.

One tree is excluded, because formatting it is undone by the tool that owns it:

| Exempt | Why |
|---|---|
| `**/drizzle-d1/meta` | `drizzle-kit generate` rewrites every snapshot and `_journal.json` without a trailing newline, so `biome format` re-adds one and the next `db:generate` removes it. The file belongs to drizzle-kit, not to this repository's style. |

`GENERATED_TREES` in `scripts/src/guards/policy.ts` is deliberately **not** extended to
cover it: that list decides what the module graph and the README guard refuse to
reason about, and adding a committed, hand-reviewed migration history there would
weaken a guard to tidy a formatter. The two lists answer different questions.
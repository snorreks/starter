# Capability matrix

What this repository has actually been observed to do, and what it has not.

Written because a single green badge over an unexecuted lane is worse than no badge.
Each row states the strongest evidence behind it, and a row that cannot be
reproduced locally says so.

Recreated by re-running the commands; do not hand-edit the status without running
the thing.

## Verified on a clean checkout

Every row below was executed in this worktree against this branch. Counts are what
the lane printed.

| Capability | How it was verified | Command | Result |
|---|---|---|---|
| Install | `bun install --frozen-lockfile`, no network-fetched tools | `bun install --frozen-lockfile` | ok |
| Unit tests | Every project's own runner, nonzero discovery | `bun run test` | 831 pass, **1 pre-existing fail** (see below) |
| Worker lane | Real `wrangler dev` on the **built** `_worker.js`, real local D1, run-id identity check | `bun run test:worker` | 19 pass, 0 fail |
| End to end | Real Playwright against the built client **and** the built Worker, one origin | `bun run e2e` | **20 pass**, 0 fail |
| Client build | `vite build` through the adapter, then a bundle check on `.svelte-kit/cloudflare/` | `bun run build && bun run check:bundle` | 44 files, ok |
| Typecheck | Every project, `svelte-check --threshold error` | `bun run typecheck` | 0 errors, 0 warnings |
| Lint and format | Biome, verified not applied | `bun run lint && bun run format` | clean |
| Guards | Seven whole-repo invariants, no baselines | `bun run guard` and `bun run guard:whole-repo` | 7/7 |
| Pi extension loading | The pinned Pi resource loader, isolated `agentDir` | `bun run --cwd .pi loader:smoke` | ok |
| Task graph is reachable | The real Moon graph, four lanes addressable by name | `bun run --cwd .pi test` | 7 pass |

### The one failing unit test is not this branch's

```
(fail) the journal > the recorded command and cwd are the ones actually used
  Expected: "/home/sonny/.herdr/worktrees/starter/pr-b-sveltekit-worker/"
  Received: "/home/sonny/.herdr/worktrees/starter/pr-b-sveltekit-worker"
```

`.pi/tests/dev_process_tool.test.ts:25` builds `REPO_ROOT` with
`fileURLToPath(new URL('../../', …))`, which keeps the trailing separator, and
asserts the recorded `cwd` equals it. The recorder calls `resolve()`, which strips
it. **Confirmed pre-existing**: the identical failure reproduces on `origin/main`
with this branch stashed. Nothing in PR B touches that code path. It is one string
normalisation in a `.pi` helper, and `.pi` is owned by PR F, so it is recorded here
rather than fixed here.

## Fixture- and boundary-verified, not run live

Implemented and exercised against a fake boundary. Correct at the seam; the
provider itself is unverified.

| Capability | Boundary used | Command |
|---|---|---|
| Cloudflare deploy planning and refusal | injected `ProcessRunner`, no network; argv observed at the process boundary | `bun run --cwd scripts test` |
| Cloudflare credential detection | `CLOUDFLARE_API_TOKEN` presence only | same |
| D1 migration planning | plan-only, local D1 applied for real | `bun run db:migrate -- --dry-run` |
| Contract lifecycle | scripted adapter, no model provider | `bun run --cwd scripts test` |
| Historical log query | recorded response fixture | `bun run --cwd scripts test` |

## Optional, configured by the operator

Not meaningful until someone supplies the prerequisite.

| Capability | Needs | Command |
|---|---|---|
| Real deploy | a Cloudflare account, a token, a Worker name, a D1 id | `bun run deploy:configure` then `bun run deploy --yes` |
| Remote migrations | the above, plus explicit confirmation | `bun run db:migrate:remote -- --env staging --yes` |
| Cloudflare historical logs | the above, plus an account id | `bun run logs web --mode staging` |
| SOPS encrypt/decrypt | `sops` and `age` on PATH, plus your own recipient | `bun run secrets:encrypt -- <gitignored-path>` |
| Visual inspection | a vision-capable provider and an adapter | `bun run e2e:visual` |
| Contract execution | **not implemented** — exits 3 | `bun run contract run <path>` |

## Not configured in the template

Deliberately absent. Each is the operator's to supply.

| Absent | Why |
|---|---|
| Cloudflare account, Worker name, D1 id | Resource ids belong to whoever instantiates the template |
| SOPS recipients and keys | Recipients identify people, not projects |
| A model provider credential | The agent tooling works without one |
| A native shell | Removed in PR A; `check:bundle` fails the build if a `@tauri-apps/*` import survives |

## Not run here

Stated plainly rather than left to discover.

| Not run | Why |
|---|---|
| **The browser lane** | `bun run test:browser` cannot start on this host — see below. **NOT RUN**, and the suite behind it has not been observed passing. |
| **Live Cloudflare** | No deployment, provisioning, remote migration or log query was executed against a real account. |
| **The visual capture** | `bun run e2e:visual` reports `SKIPPED` with the reason, by design. |

### `test:browser` cannot start on this host, and that is not a branch change

```
Error: browserType.launch: Executable doesn't exist at
  /nix/store/…-chromium-154.0.8037.57/bin/chromium_headless_shell-1243/
    chrome-headless-shell-linux64/chrome-headless-shell
```

- `pkgs.chromium` is the browser **wrapper**. It runs, and `e2e` passes with it.
- `chromium_headless_shell` is a **separate** store path. This dev shell does not
  pull it in.
- `vitest-browser` with `headless: true` resolves that shell, so it looks for an
  executable that is not there. `playwright.config.ts` does not, because
  `chromium.launch()` uses the full browser — which is why `e2e` (20 specs) and
  `test:worker` (19 specs) pass while this lane cannot start.

Setting `channel: 'chromium'` in the instance or in `launch` does **not** redirect
the resolution; it was tried and reverted rather than shipped unverified.

**Confirmed pre-existing**: the identical error reproduces on `origin/main` with
this branch stashed.

To run it, make the headless shell reachable, then re-run:

```bash
ls -d "$(dirname "$(readlink -f "$(command -v chromium)")")"/chromium_headless_shell-*
nix develop -c bun run test:browser
```

## Known gaps in this phase

Named so nobody discovers them as a surprise.

### A historical log query has never been sent

`queryCloudflareHistory` builds a real Workers Observability request and parses a
real response. **It has not been run against a provisioned account.** The request
shape is asserted against the endpoint's documented contract, and the response
handling is driven against a recorded fixture in
`scripts/tests/fixtures/observability_response.json` — so the transport is
fixture-verified and the live path is NOT RUN.

`docs/cloudflare.md` records the endpoint contract this is written against. The one
thing to check first with a credential is the token scope, which is
`Workers Observability Write` even for a read.

A future gap worth naming: a `rows_read: 0` response with a populated `data` array
has been reported for API-token queries the dashboard answers, so the CLI reports
`rows_read` rather than treating it as authoritative.

### Logpush is a claimed capability with no implementation

The registry lists Logpush for staging and production. No Logpush job is created,
no filter is registered, and nothing reads the bucket. Treat it as absent.

### The build does not catch every server import in the browser

**Verified, and it is why the graph guard exists.** Injecting
`import { env } from 'cloudflare:workers'` into `src/routes/+page.svelte`, using it in
the template, and running the real `vite build` **succeeds** — and the specifier lands in
the client chunk's sourcemap. Injecting `import { getContainer } from
'#lib/server/container.ts'` instead fails the build with SvelteKit's
`server_only_import`.

So the framework's gate is real and worth having, and it is not complete.
`scripts/tests/build_enforces_the_boundary.test.ts` asserts both directions: the build
rejects a server-module import, and the guard rejects it with no build at all.

### `guardRequestState` matches declarations, not behaviour

It flags a module-level `let env`, `let currentUser`, or a
`setEnvForRequest`-shaped helper by shape. That is a check on a pattern, not a proof
that no request state is shared across requests, and it should not be read as one.
`apps/frontend/client/tests/worker_integration.test.ts` and the E2E lane's two-session
assertions own that claim.

### The `@starter/*` package scope is unrenamed

`packages/**` keep the scope. It is not user-visible and renaming it touches every
import in the repository for no benefit. See
[rename-checklist.md](rename-checklist.md).

## Everything else in this list is closed

Recorded here because a gap list that keeps entries which no longer exist is
misleading in the same direction as one that omits real ones.

| Was listed as | Actually was | Now |
|---|---|---|
| The static frontend has no production equivalent of its Vite proxy | **real, and it was the reason for PR B.** A static client plus a separate Worker means a deployed client needs a custom domain with a route on the same zone, or a build-time absolute API base URL. Neither was wired. | one SvelteKit Worker serves HTML, assets and `/api/*` from one origin; there is no proxy to reproduce in production |
| Live tail has no coverage of its lifecycle | `bun run logs api --follow` was **dead** in every remote environment: `resolveLogAdapter` returned the historical adapter, and the tail then refused with "needs the wrangler-tail adapter" | resolves by capability; 8 tests, 6 of which fail if the old selection returns |
| `deploy:configure` writes the D1 id only to `wrangler.jsonc` | the registry was **never written at all**, so provisioning could not complete — and the documented remedy pointed at a module the `registry-valid` guard fails the build on | three layers: committed defaults, a gitignored `.starter/deployment.local.json`, then the environment |
| The registry has one set of names | `--env staging` and `--env production` produced **identical plans** | per-environment targets; an unconfigured environment is refused, not defaulted |
| No client Wrangler config | `deploy --client` had nothing to deploy, and a missing `build/` publishes an empty site while reporting success | `wrangler.jsonc`; a deploy is refused without `cloudflare/_worker.js` |
| Whole-repo guards' inputs are limited to `scripts` | **not a real gap** — the guard task already sets `cache: false` and explains why, and both controls fire from `apps/` | verified, not changed |
| Boundary guards use regexes | they reported imports inside **block comments** as violations, missed `require()`, missed template-literal specifiers, and missed imports spanning lines | scanner reads the whole file, blanks comments and strings while preserving specifiers |
| The bundle check scans for library names | **real.** Minification drops `drizzle-orm` and keeps `notes_owner_id_idx`, so a measured negative control produced a green build *and* a green check with the schema in the client chunk | the marker list is distinctive identifiers; `check_bundle.test.ts` locks the control in |

## Two defects this branch found by running, not by reading

### `not_found_handling: "404-page"` broke every browser navigation

The configuration carried `assets.not_found_handling: "404-page"`, on the reasoning
that a missing asset should 404 rather than fall through. It did exactly that —
for *navigations*. The static-assets router answers a navigation request it cannot
match itself, before the Worker runs, so:

```
curl http://127.0.0.1:4183/login                          → 200
curl -H 'Sec-Fetch-Mode: navigate' http://…/login           → 404
```

Ten E2E specs failed and every API spec passed. A difference in one header, in the
exact direction that makes a browser look broken while the tool that "works" is the
one lying. `"none"` passes the miss to the Worker, which is the SSR handler.

This is the argument for the E2E lane in one line: `curl` agreed with itself and
disagreed with the product.

### `provisionDatabase` wrote into the repository it was testing against

It resolved the Wrangler config through the absolute `CLIENT_DIR` while taking a
`root` parameter. `join(root, '/abs/path')` returns the absolute path, so `root` was
discarded — and the unit suite wrote its fixture's D1 id into the committed
`wrangler.jsonc` on every run, reporting success. The committed file now carries no
`database_id` at all, `CLIENT_DIR_RELATIVE` exists so the mistake is a type error,
and `deployment_values.test.ts` asserts against the real repository file.

## Host prerequisites the lanes need

Not part of the repository, but a missing one presents as a confusing failure.

| Prerequisite | Needed by | Symptom when absent |
|---|---|---|
| `node` on PATH | `test:worker`, `dev:worker`, `e2e` | `env: 'node': No such file or directory`, then a 4-minute readiness timeout |
| Chromium's shared libraries (`libglib-2.0.so.0`, `libnss3`, `libgbm`, X11, …) | `test:browser`, `e2e` | `error while loading shared libraries`, reported as `Target page, context or browser has been closed` |
| `CHROMIUM_PATH` pointing at a runnable browser | `test:browser`, `e2e` | Playwright falls back to its own download, which is absent on NixOS |
| the `chromium_headless_shell` store path | `test:browser` **only** | `Executable doesn't exist at …/bin/chromium_headless_shell-1243/…` |

On NixOS these come from a dev shell, which arrives with the direnv phase. Until
then, provide them yourself; the commands above name each missing one rather than
failing silently.
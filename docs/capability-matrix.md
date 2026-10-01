# Capability matrix

What this repository has actually been observed to do, and what it has not.

Written because a single green badge over an unexecuted lane is worse than no badge.
Each row states the strongest evidence behind it, and a row that cannot be
reproduced locally says so.

Recreated by re-running the commands; do not hand-edit the status without running
the thing.

## Verified on a clean checkout

| Capability | How it was verified | Command |
|---|---|---|
| Install | `bun install --frozen-lockfile`, no network-fetched tools | `bun install --frozen-lockfile` |
| Unit tests | Every project's own runner, nonzero discovery | `bun run test` |
| Browser tests | Real Chromium, real Svelte compiler | `bun run test:browser` |
| Worker integration | Real `wrangler dev`, real local D1, run-id identity check | `bun run test:integration` |
| End to end | Real Playwright against the **built** client, real Worker | `bun run e2e` |
| E2E failure propagation | A deliberately failing assertion exits nonzero | see [testing.md](testing.md) |
| E2E repeatability | Three consecutive runs, zero leaked processes | `bun run e2e` x3 |
| Client build | `vite build` plus a bundle check on the real `build/` | `bun run build && bun run check:bundle` |
| Typecheck | Every project | `bun run typecheck` |
| Lint and format | Biome, verified not applied | `bun run lint && bun run format` |
| Guards | Five whole-repo invariants, no baselines | `bun run guard` |
| Pi extension loading | The pinned Pi resource loader, isolated `agentDir` | `bun run --cwd .pi loader:smoke` |
| Deployment refusal | Mocked process boundary observes zero spawns on refusal | `bun run --cwd scripts test` |
| Remote config fails closed | The real `worker.fetch` entrypoint | `bun run --cwd apps/backend/api test` |

## Fixture- and boundary-verified, not run live

Implemented and exercised against a fake boundary. Correct at the seam; the
provider itself is unverified.

| Capability | Boundary used | Command |
|---|---|---|
| Cloudflare deploy planning and refusal | injected `ProcessRunner`, no network | `bun run --cwd scripts test` |
| Cloudflare credential detection | `CLOUDFLARE_API_TOKEN` presence only | same |
| D1 migration planning | plan-only, local D1 applied for real | `bun run db:migrate -- --dry-run` |
| Contract lifecycle | scripted adapter, no model provider | `bun run --cwd scripts test` |

## Optional, configured by the operator

Not meaningful until someone supplies the prerequisite.

| Capability | Needs | Command |
|---|---|---|
| Real deploy | a Cloudflare account, a token, Worker names, a D1 id | `bun run deploy:configure` then `bun run deploy --yes` |
| Remote migrations | the above, plus explicit confirmation | `bun run db:migrate --remote staging --yes` |
| Cloudflare historical logs | the above, plus an account id | `bun run logs api --mode staging` |
| Historical log query | implemented; **no live call has been made** — see below | `bun run logs api --mode staging` |
| SOPS encrypt/decrypt | `sops` and `age` on PATH, plus your own recipient | `bun run secrets:encrypt -- <gitignored-path>` |
| Visual inspection | a vision-capable provider and an adapter | `bun run e2e:visual` |
| Contract execution | **not implemented** — exits 3 | `bun run contract run <path>` |

## Not configured in the template

Deliberately absent. Each is the operator's to supply.

| Absent | Why |
|---|---|
| Cloudflare account, Worker names, D1 id | Resource ids belong to whoever instantiates the template |
| SOPS recipients and keys | Recipients identify people, not projects |
| Signing keys (Apple, Windows) | No key material of any kind ships here |
| A model provider credential | The agent tooling works without one |

## Known gaps in this phase

Named so nobody discovers them as a surprise. Each is a later phase's scope.

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

This is a much smaller gap than it was. The previous version was not a stub that
returned nothing — it sent a request built from a *free-text filter string*, which
is Logpush's format, to an endpoint that takes structured filters. Its tests were
green because they asserted that string. It either 400'd, or had its narrowing
ignored and returned every event in the window while reporting a filtered count.
A future gap worth naming: a `rows_read: 0` response with a populated `data` array
has been reported for API-token queries the dashboard answers, so the CLI reports
`rows_read` rather than treating it as authoritative.

### Logpush is a claimed capability with no implementation

The registry lists Logpush for staging and production. No Logpush job is created,
no filter is registered, and nothing reads the bucket. Treat it as absent.

### The static frontend has no production API equivalent of its Vite proxy

In development the client's Vite server proxies `/api` to the Worker. A deployed
client is static assets, so there is no proxy — a deployed client needs either a
custom domain with a route on the same zone, or an absolute API base URL built at
build time. Neither is wired.

### Everything else in this list is closed

Recorded here because a gap list that keeps entries which no longer exist is
misleading in the same direction as one that omits real ones. Each was closed with
a negative control, and each fix found something larger than the entry described:

| Was listed as | Actually was | Now |
|---|---|---|
| Live tail has no coverage of its lifecycle | `bun run logs api --follow` was **dead** in every remote environment: `resolveLogAdapter` returned the historical adapter, and the tail then refused with "needs the wrangler-tail adapter" | resolves by capability; 8 tests, 6 of which fail if the old selection returns |
| `deploy:configure` writes the D1 id only to `wrangler.jsonc` | the registry was **never written at all**, so provisioning could not complete — and the documented remedy pointed at a module the `registry-valid` guard fails the build on | three layers: committed defaults, a gitignored `.starter/deployment.local.json`, then the environment |
| The registry has one set of names | `--env staging` and `--env production` produced **identical plans** | per-environment targets; an unconfigured environment is refused, not defaulted |
| No client Wrangler config | `deploy --client` had nothing to deploy, and a missing `build/` publishes an empty site while reporting success | `wrangler.jsonc`; a client deploy is refused without `build/index.html` |
| Whole-repo guards' inputs are limited to `scripts` | **not a real gap** — the guard task already sets `cache: false` and explains why, and both controls fire from `apps/` | verified, not changed |
| Boundary guards use regexes | they reported imports inside **block comments** as violations, missed `require()`, missed template-literal specifiers, and missed imports spanning lines | scanner reads the whole file, blanks comments and strings while preserving specifiers |

## Host prerequisites the lanes need

Not part of the repository, but a missing one presents as a confusing failure.

| Prerequisite | Needed by | Symptom when absent |
|---|---|---|
| `node` on PATH | `test:integration`, `e2e` | `env: 'node': No such file or directory`, then a 4-minute readiness timeout |
| Chromium's shared libraries (`libglib-2.0.so.0`, `libnss3`, `libgbm`, X11, …) | `test:browser`, `e2e` | `error while loading shared libraries`, reported as `Target page, context or browser has been closed` |
| `cargo` and the system webview libraries | `tauri:*` | `cargo is not on PATH` (named explicitly by the launcher) |
| Xcode / Android SDK + NDK | mobile builds | named explicitly by the launcher |

On NixOS these come from a dev shell, which arrives with the direnv phase. Until
then, provide them yourself; the commands above name each missing one rather than
failing silently.
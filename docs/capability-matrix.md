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
| Cloudflare historical logs | the above | `bun run logs api --mode staging` |
| Historical log query | **not implemented** — see below | `bun run logs api --mode staging` |
| SOPS encrypt/decrypt | **not implemented** — exits 3 | `bun run secrets:encrypt` |
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

- **Cloudflare historical logging is a stub.** `queryCloudflareHistory` never sends
  a provider request and returns `retrieval_failed` once configuration checks pass.
  It also conflates the Workers Logs query API with Logpush. The Workers
  Observability REST API is the right default; Logpush is a separate optional
  capability. Nothing in this repository should be read as evidence that Cloudflare
  log querying works.
- **Live tail assumes each input line is an application `LogEvent`** rather than
  validating and extracting events from the provider envelope, and has no coverage
  of its process lifecycle or exit reporting.
- **`deploy:configure` writes a D1 id to `wrangler.jsonc` but not to the registry**
  that `deploy:check` reads, despite text that claimed it updated both.
- **The deployment registry has one set of names and ids**, not distinct
  staging/production targets, and Worker names are validated without being the
  source of the actual Wrangler destination.
- **No client Wrangler config exists** for the advertised client deployment, and the
  static frontend's local Vite API proxy has no production equivalent.
- **Whole-repository guards are declared with inputs limited to `scripts` source**,
  so an unrelated application edit can evade their intended scope.
- **Boundary guards use regexes and hardcoded package names**, so relative imports
  crossing workspace boundaries and some import syntaxes evade them.

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
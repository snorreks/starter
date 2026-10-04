# Capability matrix

> **This file records one round.** Recreated by re-running the commands; do not
> hand-edit a status without running the thing. Counts below are from the round
> that fixed the browser lane, the task graph and CI; earlier rounds' numbers are
> not carried forward.

What this repository has actually been observed to do, and what it has not.

Written because a single green badge over an unexecuted lane is worse than no badge.
Each row states the strongest evidence behind it, and a row that cannot be
reproduced locally says so.

## Verified on a clean checkout

Every row below was executed in this worktree against this branch. Counts are what
the lane printed.

| Capability | How it was verified | Command | Result |
|---|---|---|---|
| Install | `bun install --frozen-lockfile`, no network-fetched tools | `bun install --frozen-lockfile` | ok |
| Unit tests | Every project's own runner, nonzero discovery | `bun run test` | **883 pass, 0 fail** across 6 projects |
| **Browser lane** | Real Svelte compiler + real Chromium, through the documented provider option | `bun run test:browser` | **15 passed** |
| Worker lane | Real `wrangler dev` on the **built** `_worker.js`, real local D1, run-id identity check | `bun run test:worker` | **19 pass, 0 fail** |
| End to end | Real Playwright against the built client **and** the built Worker, one origin, per-worktree port | `bun run e2e` | **20 passed**, 0 fail |
| Client build | `vite build` through the adapter, then a bundle check on `.svelte-kit/cloudflare/` | `bun run build && bun run check:bundle` | ok |
| Typecheck | Every project; `tsc --noEmit` for 8, `svelte-check --threshold error` for 3 | `bun run typecheck` | 0 errors, 0 warnings |
| Lint and format | Biome, verified not applied | `bun run lint && bun run format` | clean |
| Guards | Seven whole-repo invariants, no baselines | `bun run guard` and `bun run guard:whole-repo` | 7/7 each |
| Workflow policy | Real parse of `.github/workflows/*.yml` | `bun run workflows` | ok across 2 workflows |
| **Fresh-template rehearsal** | Temporary checkout: no `.git`, no `node_modules`, no output, fresh `HOME`, **no credential** | `bun run smoke` | **7 steps ok** |

### The rehearsal found a fresh clone could not install

`bun install --frozen-lockfile` failed in a clean checkout:

```
note: skipped 1 workspace listed in bun.lock but not on disk: "@starter/api"
error: lockfile had changes, but lockfile is frozen
```

`bun.lock` still carried the removed separate-API workspace and its `@starter/api`
package, left behind when the API Worker was deleted. Every other lane runs in a
warm checkout, where the lockfile is already consistent with `node_modules`, so
nothing noticed. The lockfile is regenerated and `--frozen-lockfile` now succeeds
from cold.

Two more, both found the same way:

- **`.moon/workspace.yml` is committed; only `.moon/cache` is not.** Excluding the
  `.moon` directory by name produced a checkout where `bun run build` failed with
  `Unable to locate .moon/workspace.{yml,yaml,…}`.
- **`setup`'s browser-download skip was a string check** —
  `PLAYWRIGHT_BROWSERS_PATH.startsWith('/nix/store')` — rather than a capability
  check. It is now `resolveBrowser()`, the same decision the lanes make.
| Nix dev shell, browser lane | `nix develop -c`, the host the failure was reported on | `nix develop -c bun run test:browser` | **15 passed** |
| Pi extension loading | The pinned Pi resource loader, isolated `agentDir` | `bun run --cwd .pi loader:smoke` | 4 tests, ok |
| Moon cache, cold | `.moon/cache` deleted, then a lane | `bun run test:browser` | miss, `94db999a`, 7.2 s |
| Moon cache, warm | same tree, immediately again | `bun run test:browser` | `cached, 94db999a`, **52 ms** |
| Moon cache, misses | test outside `src/`, `moon.yml`, transitive source, `bun.lock` | see [testing.md](testing.md) | each a miss |

### The browser lane runs here now

It did not, and the recorded reason was wrong. The full account is in
[testing.md](testing.md); the short version is that `vitest.config.ts` selected its
executable with `instances[].launch`, which is not a member of Vitest 5's
`BrowserInstanceOption`, so the selection was silently dropped and Playwright
resolved a browser of its own — building a headless-shell path from
`PLAYWRIGHT_BROWSERS_PATH`, a directory. The documented provider option,
`playwright({ launchOptions: { executablePath } })`, fixes it, and
`scripts/tests/browser_launch.test.ts` proves the selection reaches the launched
process by running an instrumented executable and reading its marker.

The previous `channel` suggestion in this file was never verified and could not
have worked. It is removed rather than kept as advice.

## Fixture- and boundary-verified, not run live

Implemented and exercised against a fake boundary. Correct at the seam; the
provider itself is unverified.

| Capability | Boundary used | Command |
|---|---|---|
| Deployment target resolution and every refusal | pure; no network, no credential, no repository | `bun run --cwd scripts test` |
| `preflight` account / database / Worker mismatch | injected `run` at the process boundary; argv asserted to be read-only | same |
| Deploy pipeline ordering, and every failure path | injected process runner; **spawned argv recorded and asserted** | same |
| Release verification over HTTP | injected `fetch`; requested URL recorded, response body never retained | same |
| Cloudflare deploy planning and refusal | injected `ProcessRunner`, no network; argv observed at the process boundary | same |
| Cloudflare credential detection | `CLOUDFLARE_API_TOKEN` presence only | same |
| D1 migration planning | plan-only, local D1 applied for real | `bun run db:migrate -- --dry-run` |
| Written-brief scaffold and listing | real templates, temporary directories | `bun run --cwd scripts test` |
| Historical log query | recorded response fixture | `bun run --cwd scripts test` |

`/health` and `/health/ready` are real routes driven through real workerd by
`apps/frontend/client/tests/worker_integration.test.ts`, which asserts the release
identity and the `no-store` header alongside the database-backed readiness check.

## Optional, configured by the operator

Not meaningful until someone supplies the prerequisite.

| Capability | Needs | Command |
|---|---|---|
| Real deploy | a Cloudflare account, a token, per-environment Worker names, D1 ids and public origins | `bun run deploy:configure` then `bun run deploy apply --env staging --yes` |
| Remote migrations | the above, plus explicit confirmation | `bun run db:migrate:remote -- staging --yes` |
| Cloudflare historical logs | the above, plus an account id | `bun run logs web --mode staging` |
| SOPS encrypt/decrypt | `sops` and `age` on PATH, plus your own recipient | `bun run secrets:encrypt -- <gitignored-path>` |
| Visual inspection | a vision-capable provider and an adapter | `bun run e2e:visual` |

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
| **Live Cloudflare** | No deployment, provisioning, remote migration or log query was executed against a real account. |
| **The visual capture** | `bun run e2e:visual` reports `SKIPPED` with the reason, by design. |
| **`bun run e2e:visual` under this branch** | unchanged, and deliberately still reports `SKIPPED` rather than going green because image inspection is unavailable. |

### The browser lane no longer needs a `chromium_headless_shell` store path

The prerequisite table below used to list it as required by `test:browser` only. It
is not a prerequisite of anything now. What `test:browser` actually needs is that
`CHROMIUM_PATH` — or a Playwright cache — resolves to a runnable browser, and
`doctor` proves it by launching the binary rather than reading a version string.

## Known gaps in this phase

Named so nobody discovers them as a surprise.

### What this round added, and what it did not

This round (request logging, telemetry ingestion, release verification) added a
**local** evidence section rather than re-running the matrix above, because the rows
above are dated by the round that produced them. Measured on the branch below,
against a real built Worker in real workerd:

| Capability | How it was verified | Command | Result |
|---|---|---|---|
| Built Worker emits request records | Real `wrangler dev` on the built `_worker.js`; records read out of wrangler's captured console output and counted as a before/after delta | `bun run test:worker` | **61 pass, 0 fail** (8 new) |
| Forwarded browser event stored once | Same lane: a real `POST /api/telemetry`, asserting the stored record's source, release, redacted payload and `clientReported` | `bun run test:worker` | 1 record, forged `userId` never trusted |
| Two concurrent sessions isolated | Same lane: two real sign-ups, two concurrent submissions, each record mapped to its own session | `bun run test:worker` | distinct user ids per session |
| Local NDJSON record | Real Node 22.23.3 process writing through `createNdjsonStdoutEmitter`, then read back by the log CLI | `node --experimental-strip-types` + `bun run logs web --mode local` | one line per record; CLI rendered both |
| Verification asks readiness | `apply` driven with a recording `fetch` that answers 200 liveness and 503 readiness | `cd scripts && bun test tests/deployment_pipeline.test.ts` | **32 pass, 0 fail** (7 new); verify fails and still records |

**NOT RUN, with the reason:**

| Not run | Why |
|---|---|
| Remote log history (`bun run logs --mode staging\|production`) | Needs a deployed Worker and a Cloudflare account with Workers Observability access. No deployment was performed in this round. The local lane above proves emission; it says nothing about provider retention. |
| `wrangler tail` against a live Worker | Same. `wrangler dev` output is the same console stream, but it is not the provider's index. |
| `bun run deploy apply` / a live verification | This round writes no remote state by instruction. The verification logic is proven against a recording `fetch`, and a live run is the remaining step. |
| `bun run dev` (Node dev server) | **Broken on `main` too, independently of this branch.** Node 22.23.3 strips types without transforming, and `packages/shared/utils/src/lib/common/base_class.ts:142` uses a TypeScript parameter property (`constructor(protected readonly options: Options)`), which strip-only mode refuses. The Node record was therefore proven with a real Node process driving the emitter directly, and the app-level Node lane remains broken until that line is rewritten. |

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

### Logpush: removed, not deferred

The registry used to list Logpush for staging and production while nothing
implemented it — no job created, no filter registered, nothing reading a bucket. The
claim has been deleted from the registry and from this file rather than carried
forward as advice, because a capability named in documentation and absent from code
is the failure mode this matrix exists to catch. Remote history and tail are served
by Cloudflare Workers Observability and `wrangler tail`; there is no second log
platform.

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

## The media processor lane (PR G, 2026-10-03)

A separate dated section, because this file records one round per run and PR G
added a lane rather than re-running the web one. Nothing above this line changed;
the web rows describe PR #17 and are still what they were.

Rechecked on this branch with Rust 1.98.1 and Debian FFmpeg 5.1.9 in a container.
Counts below are the observed test output; image measurements come from the single
script run recorded in the crate README.

| Capability | How it was verified | Command | Result |
|---|---|---|---|
| Crate builds | release build, locked, offline in the image | `cargo build --release --locked` | ok |
| Format and lint | rustfmt check, clippy over every target with warnings denied | `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` | clean, 0 warnings |
| Unit and integration tests | real `ffmpeg`/`ffprobe` binaries; **no test skips** when they are missing, it fails naming the prerequisite | `cargo test --locked` | **79 pass, 0 fail** across 5 targets (49 lib, 15 encode, 10 HTTP, 4 protocol goldens, 1 main binary) |
| Protocol goldens | the six documents in `fixtures/protocol/` asserted against the types *and* against this build's serialization, both directions | `cargo test --locked --test protocol_golden` | 4 pass |
| Real encode | fixture → validated 320x180 H.264 MP4, output hash recomputed by the test, temp directory asserted gone | `cargo test --locked --test encode_real` | 15 pass |
| HTTP surface | real sockets against a real server: health, encode whose body a *second* `ffprobe` accepts, refusals, chunked refusal, disconnect cancellation, `429` while busy | `cargo test --locked --test http_server` | 10 pass |
| SIGTERM | the built binary as its own process, a hanging child, a real signal, temp root asserted empty afterwards | same | pass |
| Image build and run | one run on 2026-10-03, Docker 25.0.16, digest-pinned bases and Debian FFmpeg 5.1.9; health, 3 timed encodes, 5 refusals, zero temp entries and SIGTERM exit 0 | `bash scripts/measure.sh` from `apps/backend/media` (Moon uses the same invocation) | exit 1: one DRIFT because cgroup `memory.peak` was unavailable; other checks passed |
| Measurements | image 540,099,230 bytes; binary 791,840; FFmpeg 293,288; cold starts 193/178/185/179/187 ms (mean 184, max 193); encodes 424/420/417 ms, output 112,913 bytes each; peak memory unavailable | `bash scripts/measure.sh` from `apps/backend/media` | observations from that single run, matching the crate README; counts and timings are measured, not fixed assertions |

Negative controls, all against real processes, all in this round's run:

| Control | Result |
|---|---|
| 6 MB body (over the 5 MiB ceiling) | `400 payload_too_large`, refused on the header, no FFmpeg spawned |
| 16 bytes of non-media | `400 invalid_media`, terminal, zero temp files left |
| Missing `x-preset`, wrong `x-protocol`, unknown route | `400 unsupported_preset`, `400 protocol_mismatch`, `404 not_found` |
| Second request while one is in flight | `429 busy`, `retryable: true` |
| Client hangs up mid-encode | FFmpeg killed and reaped, temp directory removed, server still healthy |
| `SIGTERM` mid-encode | in-flight encode cancelled, temp root empty, exit status 0 |
| Error bodies | no `ffmpeg`, no path, no caller data — asserted against the serialized body |
| Chunked framing | refused, not buffered |

### Not run for the media processor

| Not run | Why |
|---|---|
| **Cloudflare Containers** | No container was deployed. No account, no token, no Durable Object, no Workflow. The image, the port (8080), `/health` and the `429`/`503` statuses are what PR H binds to; nothing here was exercised on Cloudflare's runtime. |
| **The `basic` instance profile under real contention** | The profile is chosen from measurements on this host (32 CPUs available to the container). Quarter-vCPU behaviour is an extrapolation from that, and PR H must confirm the chosen profile on a real instance before the demo depends on it. |
| **A second concurrent encode** | `MAX_CONCURRENT_ENCODES = 1`, so the second request is refused by design rather than served. The refusal is verified; the concurrency is deliberately absent. |
| **Other architectures** | Base image digests and every measurement are `linux/amd64`. |
| **Cloud Run Job** | Documented in the crate README, implemented nowhere. No GCP account, no storage adapter, no IAM. |
| **`cargo audit` / `cargo deny`** | Not configured. `Cargo.lock` and `cargo tree` are the dependency record. |

## The native desktop lane (PR D)

A third dated section, for the same reason as the media one: this file records one
round per run, and this round added a lane rather than re-running the web one.
Nothing above this line changed.

**Proved here, on this host:**

| Capability | How it was verified | Command | Result |
|---|---|---|---|
| Frontend build | `@sveltejs/adapter-static`, `strict: true`, bundled fallback | `bun run --cwd apps/frontend/native build` | `Wrote site to "build"`, 20 files |
| Bundle separation | Marker scan on the artifact, in both directions | `bun run --cwd apps/frontend/native check:bundle` | ok |
| Unit tests | Config validation, bearer headers, vault rules, URL allowance, bundle control | `bun run --cwd apps/frontend/native test` | **49 pass, 0 fail** |
| Device flow, both sides | Built Worker in real workerd + real local D1: request a code, approve it in a browser session, poll, use the token | `bun run test:worker` | **68 pass, 0 fail** across the file |
| Schema needs no migration | The real generator against the real schema | `bun run db:generate` | `No schema changes, nothing to migrate` |
| Rust formatting | `rustfmt --check` over `build.rs`, `src/lib.rs`, `src/main.rs` | `cargo fmt --check` | clean |
| Command refusals | Argv planning, exit codes, cwd, no `bunx` | `bun run --cwd scripts test` | 571 tests in the tooling lane |

**NOT RUN here, with the reason:**

| Capability | Why it was not run | What would run it |
|---|---|---|
| `cargo check` / `cargo test` / `cargo clippy` on `src-tauri` | This host has **no WebKitGTK 4.1** (`pkg-config --exists webkit2gtk-4.1` fails), and Tauri's Linux dependency chain cannot link without it. `cargo` itself is present; the webview libraries are not. | `bun run native:doctor`, then `cargo test --locked` in `apps/frontend/native/src-tauri` |
| A real desktop binary on Linux, macOS, Windows | Needs the toolchain above. The CI lane that does it is added by this change. | `.github/workflows/native.yml`, `desktop` job |
| Launching the packaged app | No display, no signed app, no deployment to point it at | `./apps/frontend/native/src-tauri/target/release/starter` |
| An authenticated workflow inside the shell | Both sides are proved separately (see the device rows); the last mile needs a signed-in window | A deployment, then `bun run native:dev` |
| Notarization, signing, app stores | Need credentials this repository does not have, and this change writes no remote secret. | `.github/workflows/native-release.yml`, `workflow_dispatch` |

## The native mobile lane (PR E)

A fourth dated section. This round extended the shell to Android and iOS and did
**not** re-run the web lanes, so the rows above keep their own revision.

**Proved here, on this host, without an SDK or a phone:**

| Capability | How it was verified | Command | Result |
|---|---|---|---|
| Exact mobile argv | Read out of the pinned CLI: `tauri android {init,dev,build,run} --help` on this host, and `crates/tauri-cli/src/mobile/ios/*.rs` at `tauri-cli-v2.12.1` for the macOS-only half | `bun test ./tests/native_mobile.test.ts` (cwd `scripts`) | 26 pass, 0 fail |
| `tauri ios` really is absent on Linux | The CLI answered `error: unrecognized subcommand 'ios'` | `apps/frontend/native/node_modules/.bin/tauri ios build --help` | exit 2 |
| Wrong flags refused, per platform **and** subcommand | `android build --no-sign`, `ios build --apk`, `--target <triple>`, `--host` on a build, `--debug` with `--release` | same | same |
| iOS refused as unavailable (exit 3), not as usage (exit 2) | `bun run native:ios -- build --target aarch64-sim --ci` | same | exit 3 |
| Committed config carries no dev reachability | Marker scan of `tauri.conf.json` for `usesCleartextTraffic`, `networkSecurityConfig`, `NSAppTransportSecurity`, `NSAllowsArbitraryLoads`, `NSAllowsLocalNetworking`, `NSExceptionDomains`; plus no `bundle.iOS.infoPlist` | `bun test ./tests/mobile_platform_config.test.ts` (cwd `scripts`) | 9 pass, 0 fail |
| No desktop window minimum reaches a phone | `app.windows[]` has no `minWidth`/`minHeight` | same | same |
| Android pins are the CLI's constants | `SDK_VERSION = 37`, `NDK_VERSION = 29.0.13846066` read from the pinned CLI source | `bun test ./tests/native_mobile.test.ts` | same |
| A device host cannot survive into a packaged build | `resolveApiOrigin({ dev: false, devHost })` throws; `dev` comes from the subcommand | `bun run --cwd apps/frontend/native test` | 77 pass, 0 fail |
| Lifecycle: suspend, resume, offline, disposal | A real `EventTarget`, no phone | same | same |
| The lifecycle decision | The ViewModel's rule, not the layout's: refresh only on the transition *into* `active` | same | same |
| A flag with no value, or another flag in its place | `--target`, `--target --aab`, `--host` with nothing after each | `bun test ./tests/native_mobile.test.ts` (cwd `scripts`) | 29 pass, 0 fail |
| Android prerequisites, driven with a fake environment | Empty `NDK_HOME` falling through to `ANDROID_NDK_HOME`; an SDK carrying r22 not satisfying NDK 29 | `bun test ./tests/mobile_prerequisites.test.ts` (cwd `scripts`) | 12 pass, 0 fail |
| Artifact naming and origin verification | Real ZIP containers written by the test and read by the shipped reader, with a CRC check and a deliberately corrupted fixture | `bun run --cwd apps/frontend/native test` | same |
| The marker is mandatory, every directory is checked, and a namespace URI is not a deployment | `--name`, `parseArgs`, `NEVER_AN_API_HOST` | same | same |
| Rust formatting | `cargo fmt --check` | `cargo fmt --check` in `apps/frontend/native/src-tauri` | clean |

**NOT RUN here, with the reason.** This host is Linux with no Android SDK, no JDK,
no `pkg-config` and no Xcode, so *every* row that needs a vendor toolchain or a
device is a row that CI owns:

| Capability | Why it was not run | Exact command that runs it |
|---|---|---|
| `cargo check` / `cargo test` / `cargo clippy` on `src-tauri` | No WebKitGTK 4.1 and no `pkg-config`; the dependency chain cannot link. `cargo` 1.98.1 was installed for this round, and `cargo fmt --check` does pass. | `cargo test --locked` in `apps/frontend/native/src-tauri` |
| Android debug APK | No `ANDROID_HOME`, no JDK. | `bun run native:android -- build --debug --apk --target aarch64 --ci` |
| Android release AAB | Same. | `bun run native:android -- build --aab --ci` |
| Android install + launch on an emulator | Same, plus no KVM. | `.github/workflows/native.yml`, `android` job: `adb install -r`, `am start -n com.example.starter/.MainActivity` |
| Android back key | Same. | same job, `KEYCODE_BACK` step |
| iOS simulator build | macOS only: the `ios` subcommand is not compiled into a non-macOS CLI. | `bun run native:ios -- build --target aarch64-sim --ci` on `macos-14` |
| iOS install + launch on a simulator | Same. | `.github/workflows/native.yml`, `ios` job: `xcrun simctl install` / `launch` |
| CLI failure propagation through the launcher | Needs a real Android/iOS build to fail. | the induced-failure step in each of those two jobs |
| Stronghold lock/unlock **on a phone** | The store's rules are platform-independent and unit-tested; the OS keychain interaction and process freezing are device observations. | manual, on a device: see `docs/native.md` |
| A signed AAB or iOS archive | Needs `ANDROID_KEYSTORE_*` / Apple secrets that this repository does not have, and PRs write no remote secrets. | `.github/workflows/native-release.yml`, `workflow_dispatch` with `sign: true` |
| Physical device run | A human, a provisioned device, an Apple Developer account. | Not implemented |
| Google Play / App Store Connect upload | Deliberately not implemented: a store credential in CI is a second authority with its own rollback story. | Not implemented |
| Authenticated sign-in and the notes path **on a device** | Needs a deployed API. The template ships none, and the CI lanes say so in their job summary rather than implying it. | `bun run native:android -- run --release` against a deployment |

Every row above that names a CI job is a *lane that exists*, not a lane that has
run. A lane that has not run has not proved anything, and this table keeps the two
apart for the same reason the desktop rows above do.

## Host prerequisites the lanes need

Not part of the repository, but a missing one presents as a confusing failure.

| Prerequisite | Needed by | Symptom when absent |
|---|---|---|
| `node` on PATH | `test:worker`, `dev:worker`, `e2e` | `env: 'node': No such file or directory`, then a 4-minute readiness timeout |
| Chromium's shared libraries (`libglib-2.0.so.0`, `libnss3`, `libgbm`, X11, …) | `test:browser`, `e2e` | `error while loading shared libraries`, reported as `Target page, context or browser has been closed` |
| `CHROMIUM_PATH`, or a populated Playwright cache | `test:browser`, `e2e` | `browserType.launch: Failed to launch chromium because executable doesn't exist` — or, with neither, Playwright's own download path |
| a **free** port in this checkout's range | `test:worker`, `e2e` | `PortUnavailable`, naming the port and how to find the listener |
| Rust toolchain 1.98.1 with clippy + rustfmt | `native:dev`, `native:build` | `bun run native:doctor` lists it under `MISS`, exit 3 |
| WebKitGTK 4.1 development files | `native:dev`, `native:build` on Linux | `webkit2gtk-sys`'s build script, naming a crate instead of a package |

On NixOS these come from a dev shell, which arrives with the direnv phase. Until
then, provide them yourself; the commands above name each missing one rather than
failing silently.

### Browser and Node versions on the host this was measured on

| | |
|---|---|
| OS | NixOS, `nixpkgs-unstable` via `flake.nix` |
| Bun | 1.4.2 (`.bun-version`, `config/toolchain.json`) |
| Node | 22.23.3 (`nodejs_22`) — required by `wrangler dev` and Vite |
| Chromium | 154.0.8037.57, `pkgs.chromium` from the Nix store |
| Playwright | 1.63.0, `@playwright/test` 1.63.0 |
| Moon | 2.5.5 |
| Biome | 2.5.13 |
| TypeScript | 6.0.3 |
| `@cloudflare/vitest-pool-workers` | **not adopted** — latest 0.22.0 peers `vitest ^4.1.0`, this workspace runs 5.0.2 |

The Chromium version is *not* the pinned Playwright browser: `playwright install`
is deliberately skipped on NixOS, because the downloaded build links against
`libgbm.so.1` and friends the store only provides under versioned names. The store
Chromium is used instead and is selected by path, which is why the provider option
above matters — a selected executable is launched, and a `channel` change would
only alter Playwright's own resolution.
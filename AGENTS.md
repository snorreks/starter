# AGENTS.md

Navigation and commands. Not a second architecture manual — the manuals are linked
at the bottom.

## The one rule that matters most

A command that succeeds while doing nothing is worse than a command that fails.
Never replace required functionality with an `echo`, an always-zero exit, a blanket
skip, a weakened assertion, or a silent no-op. If a prerequisite is missing,
implement and verify the boundary with a fixture, say the live check was NOT RUN and
why, and give the exact remaining command.

That rule is why several commands in this repository exit **nonzero with an
explanation** rather than printing advice and exiting 0:

| Command | Exit | Why |
|---|---|---|
| `bun run secrets:edit` | 4 | Refused on purpose. `sops <file>` already edits in place; a wrapper would be a second code path to the same file. |

The secrets operations that used to sit in that table now work. `encrypt`,
`decrypt`, `init`, `doctor`, `exec` and `update-recipients` run the real `sops`
binary and report its status; `docs/secrets.md` records what is verified against a
real `sops` and a real `age` identity, and what is not.

## Commands

Run from the repository root unless noted.

```bash
# Setup
bun install
bun run setup
bun run setup:doctor
bun run setup:doctor -- --profile native    # what a lane needs, and what to do without it

# Update — one uncached command, independent lanes, explicit apply
bun run update                         # offline preview
bun run update --yes --verify           # Nix → Bun → packages, then checks
bun run update --packages --yes         # package dependencies only
bun run update --nix --yes               # flake inputs only
bun run update --bun --yes               # Bun pin, verified runtime, mirrors + lock

# Develop — one application, two ways to run it
bun run dev                 # vite dev, Node, emulated bindings. Fast.
bun run dev:worker          # the BUILT Worker in real workerd. Requires a build.

# Build
bun run build               # vite build -> apps/frontend/client/.svelte-kit/cloudflare/
bun run check:bundle        # verify the artifact and that it matches its build mode

# Test — four engine-free application lanes, plus database and compute integrations
bun run test                # unit, every project
bun run test:browser        # real Svelte in Chromium
bun run test:worker         # build, then the built Worker in workerd + real local D1
bun run e2e                 # built client + built Worker + real browser, one origin
bun run test:all            # all four, no duplicates
bun run test:database       # local Supabase: real Postgres, Auth, Data API/RLS and concurrent RPCs.
                            # Needs Docker or Podman; not included in test:all.
bun run db:types            # regenerate Supabase database.types.ts from reset local migrations.
bun run db:types:check      # regenerate to a temporary file and compare without overwriting.
bun run test:compute        # the jobs Worker: real Workflows, real D1/R2, real FFmpeg.
                            # Needs a Docker engine, is never cached, and is NOT in
                            # test:all. Without Docker it fails with the missing
                            # prerequisite named — it never skips.
bun run coverage            # merged lcov over the unit lane + one percentage.
                            # Reports only, never gates. No branch figure: Bun
                            # emits no BRDA. Names every project it did not
                            # cover, including the Rust crate. Runs the lane
                            # with --cache off, so a cached hit cannot serve it.
bun run coverage -- --no-run   # re-render the number without the test run.

# Checks
bun run typecheck
bun run lint
bun run format
bun run guard               # whole-repository invariants
bun run guard -- --profile  # the same, plus per-guard elapsed time
bun run guard:whole-repo
bun run workflows           # CI workflow policy: pins, permissions, bounds, secrets
bun run smoke               # fresh checkout of this template, no credentials
bun run smoke -- --without-heavy   # the same, after deleting the native and compute examples
bun run evidence            # the capability matrix agrees with the evidence manifest

# Database
bun run db:generate         # drizzle-kit generate
bun run db:migrate          # local
bun run db:migrate:remote staging --yes    # requires an explicit environment
bun run db:status
bun run db:seed

# Deploy — local token in root .env.deploy (gitignored, chmod 600), never a Worker var
# Remote Wrangler configs are derived under .starter/deploy; local config stays neutral.
# Four phases, because they have different authority
bun run deploy:status                       # configured + last release. Read-only.
bun run deploy:check --env staging          # the offline plan. No credential, no network.
bun run deploy:preflight --env staging      # authenticated, read-only
bun run deploy:provision --env staging --yes   # idempotent: db, bucket, fixture, secrets
bun run deploy:apply --env staging --yes    # schema, storage, image, jobs, web, verify, record
bun run deploy:apply --env staging --yes --only jobs   # a subset, in dependency order
bun run deploy verify --env staging

# Native — a separate lane: it needs a Rust toolchain and a webview library
bun run native:doctor    # what this host can build. Exit 3 when a prerequisite is missing.
bun run native:dev       # the static app plus the Tauri shell
bun run native:build     # a release binary (unsigned; no installer, no store upload)

# Logs — one app; --source tells the two halves apart
bun run logs web --mode local --follow
bun run logs web --mode local --source browser

# Briefs — a written statement of what "done" means
bun run contract new "title"
bun run contract status
```

## Prerequisites the lanes need

Not bundled. Missing ones present as confusing failures, so each command names its
own:

| Needs | Required by | Symptom when absent |
|---|---|---|
| `node` on PATH | `dev:worker`, `test:worker`, `e2e` | `env: 'node': No such file or directory`, then a 4-minute timeout |
| Chromium's shared libraries | `test:browser`, `e2e` | `error while loading shared libraries` |
| `CHROMIUM_PATH`, or a populated Playwright cache | `test:browser`, `e2e` | `Failed to launch chromium because executable doesn't exist` |
| Docker-compatible engine | `test:database`, `test:compute` | named nonzero prerequisite; no mocked fallback |
| a free port in this checkout's range | `test:worker`, `e2e` | `PortUnavailable`, naming the port and its listener |
| Rust toolchain 1.98.1 with clippy + rustfmt | `native:dev`, `native:build` | `bun run native:doctor` names it; a missing one is exit 3, not a linker error |
| WebKitGTK 4.1 development files (Linux) | `native:dev`, `native:build` on Linux | named by `native:doctor`, which asks `pkg-config` |

See [docs/capability-matrix.md](docs/capability-matrix.md).

`nix develop` supplies the web half of that table: Bun, Node, Git, `gh`, SOPS,
age, `jq`, `ripgrep`, `fd`, direnv and a Chromium linked against the same store. On
a non-Nix host, `bun run setup` installs the browser matching the locked Playwright
version and `bun run setup:doctor` proves it launches.

**It does not supply the native half, and this is the one place that table has been
wrong.** `flake.nix` carries no Rust toolchain and no WebKitGTK. That is a decision,
not an oversight — [docs/toolchain.md](docs/toolchain.md) states it: the flake pins
what a workspace lockfile does not, and Rust is pinned per crate in
`apps/frontend/native/src-tauri/rust-toolchain.toml`. Inside `nix develop` on this
host `cargo` is not on PATH and `pkg-config` does not exist, so `bun run native:build`
exits 3 naming `webkit2gtk-4.1`: a real build refusing for a real missing
prerequisite, after the reader was told the shell would have it. The native lane
wants:

```bash
# Linux desktop: the webview development files, alongside the crate toolchain
nix shell nixpkgs#webkitgtk_4_1 nixpkgs#gtk3 nixpkgs#libsoup_3 \
             nixpkgs#libayatana-appindicator nixpkgs#librsvg \
             nixpkgs#openssl nixpkgs#libGL nixpkgs#patchelf nixpkgs#pkg-config
```

`bun run native:doctor` is the authority on whether a host can build, and it exits 3
with the missing package named rather than letting a linker report it twenty minutes
later. The same is true of Android (SDK, JDK, NDK) and iOS (macOS with full Xcode):
neither comes from this flake, and both are named by `setup:doctor --profile`.

## Layout, and the boundaries that matter

```
apps/frontend/client     ONE SvelteKit app: browser half + Worker half
apps/frontend/native     static SvelteKit app + src-tauri shell; the same features,
                         a bearer transport, an opt-in Stronghold vault
apps/backend/jobs        the jobs Worker: EncodeWorkflow, MaintenanceWorkflow, the
                         container Durable Object. No public route.
apps/backend/media       the Rust/FFmpeg processor that runs inside the container
apps/e2e                 Playwright specs + the harness that starts the server
packages/shared/*        portable; no project dependencies
packages/backend/*       database, auth — server only
packages/frontend/*      ui, platform, features — browser only
scripts                  one tooling workspace
.pi                      agent extensions, helpers, tests
```

`apps/backend/api` is gone. There is one application, one Worker, one origin, and
one production router. `apps/frontend/client/src` holds two runtimes and the
boundary between them is a path, not a convention — see below.

Boundaries, each enforced twice (Biome's import rules and `bun run guard`):

- **`@starter/*` packages import nothing from `apps/` or `scripts/`.** They are the
  portable core.
- **`apps/frontend/client/src/lib/server/**`, `hooks.server.ts` and `src/routes/**/+server.ts` / `+page.server.ts` / `+layout.server.ts` are the server plane.** They may import `@starter/database` and `@starter/auth`. Everything else in the same package may not, and a `+page.svelte` is deliberately excluded so the components beside it keep the browser-only permission set.
- **`scripts/` and `.pi` run outside both planes** and may import shared packages
  only.

Three directory rules that are *not* stylistic:

- **`.pi/extensions` contains entrypoints only.** Pi loads every module it finds
  there as an extension, so a helper or a test placed there fails on every start.
  Helpers go in `.pi/lib`, tests in `.pi/tests`. `.pi/tests/pi_loader.test.ts`
  enforces this against the real loader.
- **`@starter/utils/process` is Node-only.** It is reachable only by that subpath,
  never through the package barrel, because `@starter/utils` is linked into the
  browser bundle.
- **A server load calls the service directly.** `+page.server.ts` imports
  `#lib/server/…`, never `fetch()`ing its own origin. A round trip to `/api/notes`
  from inside the process that serves `/api/notes` is a second, differently
  authenticated path to the same data.
- **Compute is a second Worker with no public route.** The jobs Worker exports two
  Workflows and one container Durable Object and nothing else: its `fetch` answers
  404, the web Worker owns `/api/jobs` and starts an encode through a cross-Worker
  workflow binding, and the container holds no credential, no R2 key and no D1. A
  second REST API here would be a second authorization surface with no owner.
- **A feature receives its collaborators; it does not find them.** `NotesService`
  takes an `ApiTransport`, `AuthViewModel` takes a session, an account service and
  a `Navigation`. Only `apps/frontend/client/src/lib/composition/` decides which
  ones this host has. A feature that imported `$app/navigation` or resolved a
  module singleton would work in a browser and nowhere else.

- **The native app is a client of the web Worker, not a second server.**
  `apps/frontend/native/src/lib/platform/**` is the only directory permitted to name
  `@tauri-apps/*`, and no module in the native app may reach `@starter/database`,
  `@starter/auth`, `drizzle-orm`, `better-auth` or a Cloudflare binding. Two
  `check:bundle` commands assert the same property on the emitted artifacts, in
  opposite directions.
- **A count in a document is derived, never typed.** `docs/evidence/current.json`
  carries every row with its revision, platform, command, count, timestamp and
  artifact; `docs/capability-matrix.md`'s current table is generated from it and
  `bun run evidence` fails when the two disagree. Historical rows are kept, dated,
  so a regression stays answerable. This is the fix for a matrix that advertised
  883 unit / 19 Worker / 20 E2E tests from a round two revisions old.
- **An unsuffixed CI variable describes one environment, and says which.**
  `DEPLOY_ENVIRONMENT` is what scopes `CLOUDFLARE_WORKER_NAME` and its siblings;
  applying one value to both environments made the isolation check prove that staging
  and production shared a Worker, and `deploy plan` refused on every run. The
  nonsecret target map is a **repository** variable, because the credential-free
  `plan` job cannot read environment-scoped configuration at all.
- **A secret value never reaches argv, a log line or an artifact.** `wrangler secret
  put` takes the *name* in argv and the value on stdin; `secretInArgvProblem` refuses
  a value-shaped argument, and the Cloudflare API token is never a substitute for
  `BETTER_AUTH_SECRET` or `RESEND_API_KEY`.
- **One authority decides what a command would change.** `scripts/src/deploy/target.ts`
  exports `resolveTarget(environment)`, and it covers the *whole* environment: web
  Worker, jobs Worker, both Workflow identities, D1, the private R2 bucket, the image
  and its protocol, the public origin, the mail sender and the native API origin. A
  plan that printed one Worker while `apply` went on to build an image and deploy a
  second Worker was not the thing an approval was given against. Every command that
  can reach a remote resource resolves its destination through it and nothing else
  resolves one independently. Two lookups that are each correct about different
  things is how a deploy ended up migrating staging while publishing production.

## Tool resolution

Never `bunx <tool>` for anything that mutates state or runs a build. `wrangler`,
`drizzle-kit` and `playwright` are declared by single workspace packages, so
`bunx` from the repository root does not find them and downloads whatever the
registry serves. Observed drift: lockfile 4.142.0, `bunx wrangler --version`
4.144.0.

Go through the package that declares the tool:

```bash
bun run --cwd packages/backend/database db:generate
```

`scripts/src/shared/tools.ts` does this in TypeScript for the tooling workspace.

## Writing tests here

- **Name the failure, not the function.** `resolveAuthSecret` rejects a short
  secret, rather than testing `resolveAuthSecret`.
- **Make the failure reachable.** Write fixtures to a temp directory. Do not assert
  against the repository — proving a guard fails would otherwise mean breaking the
  repository.
- **Prefer real processes and real entrypoints** over mocks at the edges that
  matter. `scripts/tests/deployment_pipeline.test.ts` observes the argv that
  would be spawned; `apps/frontend/client/tests/worker_integration.test.ts` drives
  the built Worker in real workerd.
- **Drive a browser, not `curl`, when the question is about a browser.**
  `not_found_handling: "404-page"` answered a navigation request with 404 while the
  same URL answered 200 from `curl` — one header's difference, found by 10 failing
  E2E specs and zero failing API specs.
- **Inject, do not sleep, for anything time-bounded.** A timeout is proven by
  injecting a 300 ms budget at a real process (`.pi/tests/process.test.ts`), not
  by waiting longer than the real one.
- **Zero discovered tests is a failure.** Assert the count where it matters.

## Conventions worth knowing

- **Config lives in one place.** Repository paths in `scripts/src/shared/paths.ts`
  (with a test, because the wrong `../` depth is silent and reads as a missing
  file). Dev ports in `apps/frontend/client/dev_ports.ts`. Bindings in
  `apps/frontend/client/wrangler.jsonc`, which the adapter reads for both the build
  and the dev runtime, so local and deployed cannot disagree. Resource ids in the
  gitignored `.starter/deployment.local.json`.
- **Deployment mode on the Worker is explicit.** `DEPLOYMENT_ENV` decides whether
  development defaults are permitted. It is never inferred from a URL, and missing
  is an error rather than a default.
- **Identity is per request, never module scope.** A Worker isolate serves many
  concurrent requests. `getContainer` memoizes bindings on `(env, origin)`;
  `locals.user` is rebuilt from the request every time.
- **Bound everything that runs a subprocess.** Bytes, time, cancellation, exit
  status. A `limit` argument bounds lines, not bytes.
- **Comments state the invariant and its reason.** Not the history of how the bug
  got fixed — that belongs in `docs/first-round-review.md`.
- **Every first-party project has a README, and the set is discovered.** Bun
  workspaces, Moon projects and first-party `Cargo.toml` files each oblige one; the
  `project-readme` guard finds them and refuses a README that answers none of purpose,
  setup, commands, validation, or boundaries. A hardcoded list would have documented
  the five projects that existed and none of the four this round adds.
- **A new application root is classified deliberately.** `PLANE_PLACEMENTS` has no
  blanket entry for an application directory, on purpose: a project nobody has heard
  of is reported as `unclassified-source` until somebody says what runtime it has.

## Where things are written down

| | |
|---|---|
| [docs/README.md](docs/README.md) | documentation index |
| [docs/testing.md](docs/testing.md) | the lanes, and how each is verified |
| [docs/capability-matrix.md](docs/capability-matrix.md) | what is verified, fixture-verified, or not run |
| [docs/first-round-review.md](docs/first-round-review.md) | fixed and open findings |
| [docs/architecture.md](docs/architecture.md) | boundaries and why |
| [docs/auth.md](docs/auth.md) | the account lifecycle, the D1 rate limiter, and mail |
| [docs/cloudflare.md](docs/cloudflare.md) | Workers, D1, credentials, the deployment-mode binding |
| [docs/deployment.md](docs/deployment.md) | the one deployment path: the resolved target, the CI variable model, provisioning, secret installation, the ordered pipeline, migrations, concurrency, health, rollback and image retention |
| [docs/compute.md](docs/compute.md) | what the compute example does and does not do, the Cloud Run Jobs escape route, and when Stream replaces the container |
| [docs/evidence/current.json](docs/evidence/current.json) | the machine-readable record `docs/capability-matrix.md` is generated from |
| [docs/logs.md](docs/logs.md) | the log CLI and its refusals |
| [docs/secrets.md](docs/secrets.md) | SOPS: the operations, and what each one refuses |
| [docs/agent.md](docs/agent.md) | Pi extensions and trust |
| [docs/lint.md](docs/lint.md) | Biome and the guards |
| [docs/toolchain.md](docs/toolchain.md) | versions and how they are pinned |
| [docs/rename-checklist.md](docs/rename-checklist.md) | before your first release |

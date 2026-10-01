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
| `bun run contract run <path>` (without `--dry-run`) | 3 | No execution adapter yet. `--dry-run` works. |

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

# Develop
bun run dev                 # client dev server
bun run dev:api             # Worker on :8787, logs to /tmp/starter-logs/api.ndjson

# Build
bun run build               # vite build -> apps/frontend/client/build
bun run check:bundle        # verify the artifact and that it matches its build mode

# Test — four lanes, run them by name
bun run test                # unit, every project
bun run test:browser        # real Svelte in Chromium
bun run test:integration    # real wrangler dev + real local D1
bun run e2e                 # built client + real Worker + real browser
bun run test:all            # all four, no duplicates

# Checks
bun run typecheck
bun run lint
bun run format
bun run guard               # whole-repository invariants
bun run guard:whole-repo

# Database
bun run db:generate         # drizzle-kit generate
bun run db:migrate          # local
bun run db:migrate:remote   # requires an explicit environment and --yes
bun run db:status
bun run db:seed

# Deploy — reads a plan; nothing happens without --yes
bun run deploy:configure
bun run deploy:check
bun run deploy -- --dry-run
bun run deploy -- api --env staging --yes

# Logs
bun run logs client --mode local --follow
bun run logs api --mode local --follow

# Contracts
bun run contract new "title" [--mode standard|full]
bun run contract run <path> [--dry-run] [--resume]
bun run contract status
```

## Prerequisites the lanes need

Not bundled. Missing ones present as confusing failures, so each command names its
own:

| Needs | Required by | Symptom when absent |
|---|---|---|
| `node` on PATH | `test:integration`, `e2e` | `env: 'node': No such file or directory`, then a 4-minute timeout |
| Chromium's shared libraries | `test:browser`, `e2e` | `error while loading shared libraries` |
| the `chromium_headless_shell` store path | `test:browser` **only** | `Executable doesn't exist at …/chromium_headless_shell-1243/…` — see [docs/capability-matrix.md](docs/capability-matrix.md) |

See [docs/capability-matrix.md](docs/capability-matrix.md).

## Layout, and the boundaries that matter

```
apps/frontend/client     SvelteKit SPA
apps/backend/api         Worker: routes, auth, D1
apps/e2e                 Playwright specs + the harness that starts the servers
packages/shared/*        portable; no project dependencies
packages/frontend/*      browser code
scripts                  one tooling workspace
.pi                      agent extensions, helpers, tests
```

Three boundaries, each enforced twice (Biome's import rules and `bun run guard`):

- **`@starter/*` packages import nothing from `apps/` or `scripts/`.** They are the
  portable core.
- **`apps/` never imports across to another `app/`.** The client and the API talk
  over HTTP.
- **`scripts/` and `.pi` run outside both planes** and may import shared packages
  only.

Two directory rules that are *not* stylistic:

- **`.pi/extensions` contains entrypoints only.** Pi loads every module it finds
  there as an extension, so a helper or a test placed there fails on every start.
  Helpers go in `.pi/lib`, tests in `.pi/tests`. `.pi/tests/pi_loader.test.ts`
  enforces this against the real loader.
- **`@starter/utils/process` is Node-only.** It is reachable only by that subpath,
  never through the package barrel, because `@starter/utils` is linked into the
  browser bundle.

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
  matter. `process_boundary.test.ts` observes the argv that would be spawned;
  `worker_config.test.ts` calls the real `worker.fetch`.
- **Inject, do not sleep, for anything time-bounded.** The contract runner's
  per-stage deadline is proven by injecting a 50 ms budget.
- **Zero discovered tests is a failure.** Assert the count where it matters.

## Conventions worth knowing

- **Config lives in one place.** Repository paths in `scripts/src/shared/paths.ts`
  (with a test, because the wrong `../` depth is silent and reads as a missing
  file). Dev ports in `apps/frontend/client/dev_ports.ts`. App-to-Worker mapping in
  the app registry.
- **Deployment mode on the Worker is explicit.** `DEPLOYMENT_ENV` decides whether
  development defaults are permitted. It is never inferred from a URL, and missing
  is an error rather than a default.
- **Bound everything that runs a subprocess.** Bytes, time, cancellation, exit
  status. A `limit` argument bounds lines, not bytes.
- **Comments state the invariant and its reason.** Not the history of how the bug
  got fixed — that belongs in `docs/first-round-review.md`.

## Where things are written down

| | |
|---|---|
| [docs/README.md](docs/README.md) | documentation index |
| [docs/testing.md](docs/testing.md) | the four lanes, and how each is verified |
| [docs/capability-matrix.md](docs/capability-matrix.md) | what is verified, fixture-verified, or not run |
| [docs/first-round-review.md](docs/first-round-review.md) | fixed and open findings |
| [docs/architecture.md](docs/architecture.md) | boundaries and why |
| [docs/cloudflare.md](docs/cloudflare.md) | deploy, D1, workers, credentials |
| [docs/logs.md](docs/logs.md) | the log CLI and its refusals |
| [docs/secrets.md](docs/secrets.md) | SOPS: the operations, and what each one refuses |
| [docs/agent.md](docs/agent.md) | Pi extensions and trust |
| [docs/lint.md](docs/lint.md) | Biome and the guards |
| [docs/toolchain.md](docs/toolchain.md) | versions and how they are pinned |
| [docs/rename-checklist.md](docs/rename-checklist.md) | before your first release |
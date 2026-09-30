# Bun + SvelteKit + Tauri + Cloudflare starter

A full-stack starter with one demo entity, worked end to end: a schema shared by
client and server, a Cloudflare Worker with D1, a SvelteKit client, a Tauri shell,
and a test suite that runs without a single credential.

The demo is a notes app. It is small on purpose — enough to exercise every
convention, little enough that you will replace it.

## What you get

| | |
|---|---|
| **Runtime** | Bun, strict TypeScript, Moon for task orchestration, Biome for lint and format |
| **Frontend** | SvelteKit 3 + Svelte 5, real-browser tests via Vitest |
| **Backend** | Elysia 1.4 on Cloudflare Workers, D1 via Drizzle, Better Auth (email/password) |
| **Native** | Tauri 2 shell for desktop and mobile |
| **Tests** | 377 tests across six lanes, all running without credentials |
| **Tooling** | `logs` CLI, database and deploy scripts, five architectural guards, Pi agent config |

Nothing is provisioned. There are no Cloudflare resource ids, no signing keys, no
domains, and no tokens anywhere in the repository — see
[docs/starter-extraction.md](docs/starter-extraction.md).

## Getting started

```bash
bun install
bun run setup          # checks the toolchain, writes .env from the examples
bun run db:migrate     # applies migrations to local D1
bun run dev            # client on :5173
bun run dev:api        # Worker on :8787, logs to /tmp/starter-logs/api.ndjson
```

Then sign up at <http://127.0.0.1:5173/login>.

The client dev port is decided in one place,
`apps/frontend/client/dev_ports.ts`, because `tauri.conf.json` cannot read an
environment variable and the two used to disagree — so `tauri dev` opened a window
on a port nothing was listening on. Override with `PORT`.

Nothing above needs a Cloudflare account. The local Worker runs against Wrangler's
local D1.

## Tests

Four lanes. Each is a separate command, and each is verified to fail when it should:

```bash
bun run test             # unit, every project
bun run test:browser     # real Svelte in Chromium
bun run test:integration # real Worker + real D1
bun run e2e              # built client + real Worker + real browser
bun run test:all         # all four, no duplicates

bun run typecheck
bun run lint
bun run guard            # whole-repository invariants
```

| Lane | Runs | Proves |
|---|---|---|
| Unit | Bun | Pure logic, schema refusals, flag parsing, deploy plans, state machines |
| Browser | Chromium | Reactivity through the real Svelte compiler |
| Integration | `wrangler dev` + D1 | Worker routing, auth, cross-user authorization |
| E2E | built client + Worker + Chromium | The whole path, through a real build |

`bun run e2e` used to reach an `echo` — CI applied migrations, installed Chromium,
printed a message and went green without executing a single test. It now runs the
17 Playwright specs, and a deliberately failing browser assertion is confirmed to
make it exit nonzero. See [docs/testing.md](docs/testing.md).

`bun run e2e:visual` captures four screens to a local directory. Vision inspection
reports as **SKIPPED** with a reason — never as a pass.

Some lanes need a system prerequisite: `node` on PATH for anything starting
`wrangler dev`, and Chromium's shared libraries for the browser lanes. Each command
names what is missing rather than failing obscurely. See
[docs/capability-matrix.md](docs/capability-matrix.md) for what is verified, what is
fixture-verified, and what has not been run at all.

## Architecture

```
apps/
  frontend/client    SvelteKit app, browser and Tauri webview
  backend/api        Elysia Worker
  e2e                Playwright
packages/
  shared/            schemas, logger, utils — portable, no dependencies
  frontend/          ui, services — browser code
  backend/           database, auth — server code
scripts/             CLI: logs, db, deploy, guards, contract, setup
.pi/                 agent settings, skills, prompts, the log tool
```

The dependency direction is one-way and enforced:

```
shared  →  (nothing)
backend →  shared
frontend →  shared
api     →  shared, backend
client  →  shared, frontend
```

`bun run guard` fails on the reverse. The linter enforces the same boundaries at
the import level; the guards additionally cover what a linter cannot see.

### Conventions

- **A route page owns one thing**: constructing a ViewModel. Logic goes in a
  ViewModel behind it.
- **A ViewModel holds state**, a service performs I/O, a component formats.
- **`status` is a tagged union** (`loading | ready | error`), never a boolean plus a
  separate error field.
- **Ownership is enforced in the query**, never after the fetch.
- **One TypeBox.** `@sinclair/typebox`, because that is what Elysia validates
  with. One documented exception in `.pi/`, where Pi's API requires the 1.x line.
- **No `as unknown as`, no `as any`.** If a cast is needed, the boundary is wrong.

## Documentation

Start at [AGENTS.md](AGENTS.md) for commands and navigation.

| | |
|---|---|
| [AGENTS.md](AGENTS.md) | Commands, layout, and the conventions that matter |
| [docs/README.md](docs/README.md) | Documentation index |
| [docs/capability-matrix.md](docs/capability-matrix.md) | What is verified, fixture-verified, or **not run** |
| [docs/first-round-review.md](docs/first-round-review.md) | Fixed and open findings |
| [docs/architecture.md](docs/architecture.md) | Layering, request lifecycle, why the boundaries are where they are |
| [docs/adding-a-feature.md](docs/adding-a-feature.md) | Adding an entity, in the order that works |
| [docs/testing.md](docs/testing.md) | The four lanes, and how each is verified |
| [docs/logs.md](docs/logs.md) | `bun run logs`, and what each refusal means |
| [docs/lint.md](docs/lint.md) | Biome, and the rules that are off and why |
| [docs/toolchain.md](docs/toolchain.md) | Version pinning, and what Moon is for |
| [docs/cloudflare.md](docs/cloudflare.md) | Provisioning, deploying, what is separate from what |
| [docs/native.md](docs/native.md) | Tauri: renaming, capabilities, mobile, adding an updater |
| [docs/secrets.md](docs/secrets.md) | SOPS, what is not implemented, and what never goes in the repository |
| [docs/agent.md](docs/agent.md) | The Pi setup, skills, and the log tool |
| [docs/rename-checklist.md](docs/rename-checklist.md) | Everything to change to make this yours |

## Before you publish

Run through [docs/rename-checklist.md](docs/rename-checklist.md). The short version:

```bash
bun run deploy:configure -- --provision   # create your D1, set your ids
# then set productName/identifier in src-tauri/tauri.conf.json
```

The template provisions nothing on purpose. A fresh clone should reach a working
local state and refuse, clearly, to deploy anywhere.

## License

MIT
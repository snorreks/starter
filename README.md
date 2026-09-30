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

Nothing above needs a Cloudflare account. The local Worker runs against Wrangler's
local D1.

## Tests

```bash
bun run test            # every unit lane
bun run test:browser    # real Svelte in Chromium
bun run e2e             # real client + real Worker + real D1
bun run typecheck
bun run lint
bun run guard           # five architectural invariants
```

The lanes, and what each is for:

| Lane | Count | Runs | Proves |
|---|---|---|---|
| Unit (`packages/**`) | 171 | Bun | Pure logic, schema refusals, redaction |
| Unit (`scripts`) | 130 | Bun | Flag parsing, deploy and migration plans |
| Unit (client, `.pi`) | 32 | Bun | Transport classification, tool argv |
| Browser | 15 | Chromium | Reactivity through the real Svelte compiler |
| Integration | 12 | `wrangler dev` + D1 | Worker routing, auth, authorization |
| E2E | 17 | built client + Worker | The whole path, including cross-account denial |

`bun run e2e:visual` captures four screens to a local directory. Vision inspection
reports as **SKIPPED** with a reason — never as a pass.

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

| | |
|---|---|
| [docs/architecture.md](docs/architecture.md) | Layering, request lifecycle, why the boundaries are where they are |
| [docs/adding-a-feature.md](docs/adding-a-feature.md) | Adding an entity, in the order that works |
| [docs/testing.md](docs/testing.md) | The five lanes and what each can and cannot tell you |
| [docs/logs.md](docs/logs.md) | `bun run logs`, and what each refusal means |
| [docs/lint.md](docs/lint.md) | Biome, and the two rules that are off and why |
| [docs/toolchain.md](docs/toolchain.md) | Bun version pinning, and what Moon is for |
| [docs/cloudflare.md](docs/cloudflare.md) | Provisioning, deploying, what is separate from what |
| [docs/native.md](docs/native.md) | Tauri: renaming, capabilities, mobile, adding an updater |
| [docs/secrets.md](docs/secrets.md) | direnv, SOPS, and what never goes in the repository |
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
# Bun + SvelteKit + Cloudflare starter

A full-stack starter with one demo entity, worked end to end: a schema shared by
client and server, a Cloudflare Worker with D1, a SvelteKit client, and a test
suite that runs without a single credential.

The demo is a notes app. It is small on purpose — enough to exercise every
convention, little enough that you will replace it.

## What you get

| | |
|---|---|
| **Runtime** | Bun, strict TypeScript, Moon for task orchestration, Biome for lint and format |
| **App** | SvelteKit 3 + Svelte 5 on Cloudflare Workers via `@sveltejs/adapter-cloudflare`, D1 via Drizzle, Better Auth (email/password) |
| **Shape** | One application, one Worker, one origin. The pages, the hashed assets and `/api/*` are all served from the same hostname. |
| **Tests** | Four lanes, all running without credentials |
| **Tooling** | `logs` CLI, database and deploy scripts, eight architectural guards, Pi agent config |

There is no separate backend to deploy and no dev proxy to keep honest. The browser
half and the Worker half are the same package, separated by a path the linter and
`bun run guard` both check.

The application is a web app. There is still no native shell: no desktop or mobile
bundle and no `@tauri-apps/*` dependency to upgrade. A product that needs one
should add a client and an authenticated API boundary deliberately.

One Rust crate sits outside both planes:
[`apps/backend/media`](apps/backend/media/README.md) is a bounded FFmpeg encode
processor — an internal HTTP entrypoint for Cloudflare Containers and a finite CLI
for a batch runner, sharing one encoding core. It is not part of `bun run test`,
`lint` or `typecheck`: the web lanes stay free of a Rust toolchain and of FFmpeg,
and the compute lane names its own prerequisites.

Nothing is provisioned. There are no Cloudflare resource ids, no signing keys, no
domains, and no tokens anywhere in the repository — see
[docs/starter-extraction.md](docs/starter-extraction.md).

## Getting started

```bash
bun install
bun run setup          # checks the toolchain, writes .env from the example
bun run db:migrate     # applies migrations to local D1
bun run dev            # the app on PORT (default :5173)
```

Then sign up at <http://127.0.0.1:5173/login>.

`bun run dev` runs the server code in Node with the Worker's bindings emulated by
the adapter from `wrangler.jsonc` — fast, with hot reload, but workerd is not
involved. When you want the real runtime, build and use the other mode:

```bash
bun run build          # -> apps/frontend/client/.svelte-kit/cloudflare/
bun run check:bundle   # verify the artifact
bun run dev:worker     # the compiled Worker in real workerd, on the same port
```

The dev port comes from `apps/frontend/client/dev_ports.ts`, which reads `PORT` and
defaults to 5173.

Nothing above needs a Cloudflare account. The local Worker runs against Wrangler's
local D1.

## Commands

Every command runs from the repository root unless it says otherwise. AGENTS.md is
the authority and the full list; these are the ones a first hour needs, and each one
names what is missing rather than failing obscurely:

| Command | What it does |
|---|---|
| `bun install` | Install from the committed lockfile. |
| `bun run setup` | Check the toolchain and write `.env` from the example. |
| `bun run setup:doctor` | Prove the browser prerequisites actually launch. |
| `bun run dev` | The app in Node with emulated bindings. `apps/frontend/client` has its own ports. |
| `bun run dev:worker` | The **built** Worker in real workerd. Requires `bun run build` first. |
| `bun run test:all` | The four test lanes, no duplicates. |
| `bun run guard` | Eight whole-repository invariants. |
| `bun run deploy:check --env staging` | The offline deployment plan. No credential, no network. |

## Tests

Four lanes. Each is a separate command, and each is verified to fail when it should:

```bash
bun run test             # unit, every project
bun run test:browser     # real Svelte in Chromium
bun run test:worker      # build, then the built Worker in workerd + real D1
bun run e2e              # built client + built Worker + real browser
bun run test:all         # all four, no duplicates

bun run typecheck
bun run lint
bun run guard            # whole-repository invariants
```

| Lane | Runs | Proves |
|---|---|---|
| Unit | Bun | Pure logic, schema refusals, flag parsing, deploy plans, state machines |
| Browser | Chromium | Reactivity through the real Svelte compiler |
| Worker | `wrangler dev` + D1 | Routing, auth, cross-user authorization, 404 shapes |
| E2E | built client + built Worker + Chromium | The whole path, through a real build and one origin |

The E2E lane runs the *built* Worker in real workerd, so it catches a bundling
mistake, an Svelte SSR crash, and a dev-only success — none of which the unit or
browser lane can see. It also earns its keep on things no other lane would notice:
`assets.not_found_handling: "404-page"` answered a browser *navigation* with 404
while the same URL answered 200 from `curl`, and only the browser specs noticed.
See [docs/testing.md](docs/testing.md).

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
  frontend/client    ONE SvelteKit app — browser half and Worker half
  e2e                Playwright
packages/
  shared/            schemas, logger, utils — portable, no dependencies
  frontend/          ui, platform, features — browser code
  backend/           database, auth — server code
scripts/             CLI: logs, db, deploy, guards, contract, setup
.pi/                 agent settings, skills, prompts, the log tool
```

The dependency direction is one-way and enforced:

```
shared   →  (nothing)
backend  →  shared
frontend →  shared
client   →  shared, frontend        (the browser half)
           shared, backend           (src/lib/server/** and route adapters)
```

`apps/frontend/client/src` holds two runtimes. Everything under `src/lib/server/`,
`hooks.server.ts`, and the `+server.ts` / `+page.server.ts` / `+layout.server.ts`
adapters may import the database and auth packages. Everything else in the same
directory — components, ViewModels, client services — may not. `bun run guard` and
Biome both draw that line.

`bun run guard` fails on the reverse. The linter enforces the same boundaries at
the import level; the guards additionally cover what a linter cannot see.

### Conventions

- **A route page owns one thing**: constructing a ViewModel. Logic goes in a
  ViewModel behind it.
- **A ViewModel holds state**, a service performs I/O, a component formats.
- **`status` is a tagged union** (`loading | ready | error`), never a boolean plus a
  separate error field.
- **Ownership is enforced in the query**, never after the fetch.
- **A server load calls the service directly.** A `+page.server.ts` imports
  `#lib/server/…`; it never fetches its own origin. There is one mutation path.
- **One TypeBox.** `@sinclair/typebox`, validated identically by the browser and the
  Worker. One documented exception in `.pi/`, where Pi's API requires the 1.x line.
- **No `as unknown as`, no `as any`.** If a cast is needed, the boundary is wrong.

## Documentation

Start at [AGENTS.md](AGENTS.md) for commands and navigation.

| | |
|---|---|
| [AGENTS.md](AGENTS.md) | Commands, layout, and the conventions that matter |
| [docs/README.md](docs/README.md) | Documentation index |
| [docs/capability-matrix.md](docs/capability-matrix.md) | What is verified, fixture-verified, or **not run** |
| [docs/first-round-review.md](docs/first-round-review.md) | Fixed and open findings |
| [docs/architecture.md](docs/architecture.md) | The canonical decision record: exact versions, why the adapter and not the Vite plugin, runtime boundaries, route ownership |
| [docs/adding-a-feature.md](docs/adding-a-feature.md) | Adding an entity, in the order that works |
| [docs/testing.md](docs/testing.md) | The four lanes, and how each is verified |
| [docs/logs.md](docs/logs.md) | `bun run logs`, and what each refusal means |
| [docs/lint.md](docs/lint.md) | Biome, and the rules that are off and why |
| [docs/toolchain.md](docs/toolchain.md) | Version pinning, and what Moon is for |
| [docs/cloudflare.md](docs/cloudflare.md) | Workers, D1, credentials, the deployment-mode binding |
| [docs/deployment.md](docs/deployment.md) | The one deployment path: configuration authority, the pipeline, migrations, concurrency, health, and how to recover from a bad release |
| [docs/secrets.md](docs/secrets.md) | SOPS, what is not implemented, and what never goes in the repository |
| [docs/agent.md](docs/agent.md) | The Pi setup, skills, and the log tool |
| [docs/rename-checklist.md](docs/rename-checklist.md) | Everything to change to make this yours |

## Before you publish

Run through [docs/rename-checklist.md](docs/rename-checklist.md). The short version:

```bash
bun run deploy:configure -- --account <32-hex>
bun run deploy:configure -- --env staging --worker <name>
bun run deploy:configure -- --env staging --origin https://<host>
bun run deploy:configure -- --env staging --provision

bun run deploy:check --env staging   # the plan, offline. Reads nothing secret.
```

The template provisions nothing on purpose. A fresh clone reaches a working local
state and refuses, clearly, to deploy anywhere. Deployment is manual and
per-environment: see [docs/deployment.md](docs/deployment.md).

## License

MIT
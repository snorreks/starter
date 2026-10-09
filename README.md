# Starter

## Purpose

A typed SvelteKit application for web and native clients. Supabase owns identity and relational data; a Cloudflare Worker owns HTTP operations; optional Cloud Run processing is orchestrated by a private Workflows Worker.

## Stack

| Area | Implementation |
|---|---|
| Web | SvelteKit, Svelte 5, Cloudflare Workers |
| Identity and data | Supabase Auth, Postgres, RLS and transactional RPCs |
| Native | Tauri, Supabase PKCE, optional Stronghold credential vault |
| Objects | Private Cloudflare R2 when compute is enabled |
| Compute | Optional Cloudflare Workflows + Cloud Run Jobs + Rust/FFmpeg |
| Tooling | Bun, Moon, TypeScript, Biome and portable Pi tools |

## Setup

```bash
bun install
bun run setup
bun run setup:doctor
bun run setup:doctor -- --profile database
```

The fresh template carries no Supabase, Cloudflare or Google resource identifiers. Local Supabase requires Docker or Podman. Hosted credentials are not needed for unit tests.

## Develop and build

```bash
bun run dev                 # SvelteKit with local emulated Worker bindings
bun run build
bun run check:bundle
bun run dev:worker          # built Worker in real workerd
```

## Test

```bash
bun run test                # credential free unit lane
bun run test:browser        # Chromium
bun run test:worker         # built Worker + local Supabase
bun run e2e                 # real browser and Worker
bun run test:all             # unit, browser, Worker and E2E once each
bun run test:database       # Docker: Postgres, Auth, Data API/RLS, concurrency
bun run test:compute        # Docker: finite Cloud Run runner and real FFmpeg
```

Missing runtime prerequisites fail with a named nonzero result. Hosted Supabase, Resend, Cloud Run and physical-device checks are separate live operations and are not certified by local tests.

## Verify, smoke and evidence

```bash
bun run typecheck
bun run lint
bun run format
bun run guard:whole-repo
bun run workflows
bun run db:types:check
bun run smoke
bun run smoke -- --without-heavy
bun run evidence
```

The web-only smoke runs on a fresh copy after removing native and compute application examples. Current capability evidence is recorded in [docs/evidence/current.json](docs/evidence/current.json) and its table is generated in [docs/capability-matrix.md](docs/capability-matrix.md).

## Commands

Run the commands in this guide from the repository root unless a package directory is stated.

## Deploy

```bash
bun run deploy:check --env staging
bun run deploy:preflight --env staging
bun run deploy:provision --env staging --yes
bun run deploy:apply --env staging --yes
bun run deploy verify --env staging
```

Planning is offline; preflight is read only; provisioning and apply are explicit. Keep the old live deployment until its replacement has been separately validated and authorized. This migration does not move existing users or data and does not delete hosted resources.

## Architecture and operations

- [Architecture](docs/architecture.md)
- [Authentication](docs/auth.md)
- [Database](packages/backend/database/README.md)
- [Cloudflare](docs/cloudflare.md)
- [Optional compute](docs/compute.md)
- [Deployment](docs/deployment.md)
- [Testing](docs/testing.md)
- [Native](docs/native.md)
- [Toolchain](docs/toolchain.md)
- [Documentation index](docs/README.md)

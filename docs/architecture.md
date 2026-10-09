# Architecture

One application with web and native clients. Supabase Auth owns identity, Supabase Postgres owns relational data, the Cloudflare web Worker owns application operations, and the Tauri app is an HTTP client. Optional processing uses a private jobs Worker, Cloudflare Workflows, Cloud Run Jobs and R2.

## Runtime map

```text
Browser ─┐                         ┌─ Supabase Auth / Postgres (RLS + RPCs)
         ├─ web Worker services ───┤
Native ──┘                         └─ private jobs Worker → Workflows → Cloud Run
                                                         └─ R2 signed grants
```

The browser uses web remote functions for notes and HTTP for auth, chat, jobs and streaming operations. Native uses stable HTTP DTOs and bearer tokens; it does not call generated SvelteKit remote endpoints. Both clients share contracts and feature services, not server modules.

## Source boundaries

- `packages/shared/*` contains portable contracts and utilities. It imports no app or tooling source.
- `packages/backend/auth` and `packages/backend/database` are server only. Auth and database integrations use Supabase; privileged clients remain in server modules.
- `packages/frontend/*` contains UI, platform and features. Features receive services and navigation through composition; they do not resolve framework globals.
- `apps/frontend/client/src/lib/server/**`, server hooks, server loads and `+server.ts` routes form the web server plane. Browser components cannot import backend packages.
- `*.remote.ts` modules are web remote adapters. Their wrappers and emitted browser artifacts cannot contain service code or secrets.
- `apps/frontend/native/src/lib/platform/**` is the only native directory allowed to import `@tauri-apps/*`. The native app has no database package, server auth package or Cloudflare bindings.
- `apps/backend/jobs` owns Workflow orchestration and scheduled maintenance. It has no public route and no identity UI. Postgres persistence is implemented by Supabase RPC adapters.
- `apps/backend/media` contains the Rust finite encode runner. The Cloud Run job invokes its `encode` entrypoint; its HTTP development endpoint is not the hosted job interface.
- `scripts/` and `.pi` run outside both application planes. Pi extension entrypoints are in `.pi/extensions`; helpers and tests live in `.pi/lib` and `.pi/tests`.

Biome import policy and `bun run guard:whole-repo` enforce these boundaries. The browser and native bundle checks inspect emitted artifacts as well as source imports.

## Identity, data and request handling

Supabase user identities are UUIDs. Each request verifies its token and constructs a new application identity and user database client. Owner ids are never accepted as authorization from request bodies. RLS independently enforces ownership for direct Data API callers. Admin/service role operations are separate and server only.

SQL migrations are authoritative. Generated Supabase types describe database rows; Valibot contracts describe public DTOs. Repository adapters explicitly project rows into DTOs. Multi-step admission, retries, chat turns and job state transitions use bounded transactional RPCs with fixed search paths and explicit grants.

Server page loads call application services directly rather than making an HTTP request back to the same Worker. HTTP handlers, remote functions and native routes delegate to shared operations.

## Optional compute

`JOBS_PROFILE=disabled` is explicit in the fresh template. Enabled compute requires a fully resolved Cloud Run, Supabase, R2 and Workflow target; missing settings fail with their names. Postgres owns job state and fencing, Workflows own durable orchestration, Cloud Run owns finite processing, and R2 owns bytes. The runner receives opaque ids and expiring grants, not persistent Supabase or R2 credentials.

## Tooling and evidence

A target is resolved once by `scripts/src/deploy/target.ts`; plan, preflight, provision and apply use the same environment. Local Supabase runs have unique project ids and owned ports/state. Required runtime tests do not pass from an empty suite or a cached integration result.

`docs/evidence/current.json` is the evidence source; `docs/capability-matrix.md` is generated from it. TypeBox remains only at the Pi SDK registration boundary that requires TypeBox/JSON Schema; first party application DTOs use Valibot.

See [docs/auth.md](auth.md), [the database package](../packages/backend/database/README.md), [docs/testing.md](testing.md), [docs/deployment.md](deployment.md) and [docs/native.md](native.md).

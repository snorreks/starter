# Native client

## Purpose

Tauri shell around the shared Svelte application. It calls the web Worker over bearer HTTP and uses Supabase PKCE through the external browser. It does not embed server code or database clients.

## Setup

Configure the public native build values for the selected environment:

- `VITE_NATIVE_API_ORIGIN` — the HTTPS API origin (origin only, no path).
- `VITE_NATIVE_SUPABASE_URL` — the HTTPS Supabase project origin.
- `VITE_NATIVE_SUPABASE_PROJECT_REF` — the project reference.
- `VITE_NATIVE_SUPABASE_ANON_KEY` — the public anon/publishable key.
- `VITE_NATIVE_ENVIRONMENT` — the deployment environment name.

The callback is fixed at `com.example.starter://auth/callback`; it is not configurable. Both API and Supabase URLs must be origins without paths, queries or fragments. HTTPS is required outside explicitly configured loopback development. The service role key and Google dispatcher credential are server only.

Credentials remain in memory unless the user opts into Stronghold storage. Refresh is single flight and logout clears persisted state and invalidates pending refreshes. See [docs/native.md](../../../docs/native.md) and [docs/auth.md](../../../docs/auth.md).

## Commands

From the repository root:

```bash
bun run --cwd apps/frontend/native typecheck
bun run --cwd apps/frontend/native test
bun run native:doctor
bun run native:dev
bun run native:build
```

`native:doctor` reports missing public configuration, Rust and webview prerequisites by name. Unit and bundle tests are not physical-device evidence.

## Validation

Run the scoped test and typecheck commands above. After a static frontend build, `bun run --cwd apps/frontend/native check:bundle` checks the emitted files for privileged server-code markers. These checks are not Rust or physical-device evidence.

## Boundaries

The native app uses browser safe packages and calls the web API. It cannot import server packages or Cloudflare bindings. See [the architecture guide](../../../docs/architecture.md).

# Native client

## Purpose

Tauri shell around the shared Svelte application. It calls the web Worker over bearer HTTP and uses Supabase PKCE through the external browser. It does not embed server code or database clients.

## Setup

Set the public Supabase URL, publishable key, API origin and exact callback URI for the selected environment. The service role key and Google dispatcher credential are server only. An empty Supabase configuration fails validation.

Credentials remain in memory unless the user opts into Stronghold storage. Refresh is single flight and logout clears persisted state and invalidates pending refreshes. See [docs/native.md](../../../docs/native.md) and [docs/auth.md](../../../docs/auth.md).

## Commands

```bash
bun run typecheck
bun run test
bun run native:doctor
bun run native:dev
bun run native:build
```

`native:doctor` reports missing Rust, WebKitGTK, Android or iOS prerequisites by name. Unit and bundle tests are not physical-device evidence.

## Validation

Run `bun run native:test` and `bun run native:typecheck` from the repository root; bundle checks confirm privileged server credentials are absent from emitted native files.

## Boundaries

The native app uses browser safe packages and calls the web API. It cannot import server packages or Cloudflare bindings. See [the architecture guide](../../../docs/architecture.md).

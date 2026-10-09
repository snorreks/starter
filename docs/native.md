# Native application

The Tauri application is a client of the same web Worker and Supabase project as the web client. It is not a second server and contains no database or administrative credential.

## Sign in and sessions

Native authentication uses Supabase PKCE with the system browser and an exact configured callback allowlist. The app exchanges the callback code, stores access/refresh tokens in memory by default, and persists them only when the user opts into the Stronghold vault. Stored credentials are versioned and scoped to the Supabase project, API origin and account. Refresh is single flight; logout clears the vault and invalidates pending refresh publication.

The legacy device authorization flow and legacy bearer-vault records are removed. Users authenticate again through Supabase; there is no automatic identity migration.

## Configuration and checks

Native builds require the public Supabase URL, publishable key, API origin and redirect URI. Missing public settings fail configuration. The service role key and Google dispatcher credential must never enter the native bundle.

```bash
bun run native:doctor
bun run --cwd apps/frontend/native typecheck
bun run --cwd apps/frontend/native test
bun run native:build
```

`native:doctor` names missing Rust, WebKitGTK, Android SDK/JDK/NDK or Xcode prerequisites and exits nonzero. Unit and static bundle checks do not prove physical-device deep links or Stronghold behavior. Android/iOS live flows remain NOT RUN unless those devices and toolchains are available.

See [docs/auth.md](auth.md), [docs/toolchain.md](toolchain.md), and [apps/frontend/native/README.md](../apps/frontend/native/README.md).

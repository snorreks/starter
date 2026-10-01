# Native (Tauri)

The desktop and mobile shell. It provides a window, a secure context, and native
log capture — nothing else.

## Running it

Run from the repository root:

```bash
bun run tauri:dev         # desktop, with dev reload
bun run tauri:build       # release bundle for this platform
bun run tauri:icon        # regenerate icons from src-tauri/icons/icon.svg

bun run tauri:build -- --target android
bun run --cwd apps/frontend/client tauri android init
bun run --cwd apps/frontend/client tauri ios init
```

Every *build* goes through the launcher, including mobile: `tauri build` run
directly sets no native-build flag, so an Android or iOS bundle made that way ships
the throwing `@tauri-apps/*` stub — an app whose native calls throw. The two `init`
commands compile nothing, so they need no flag and stay as the direct invocations
they are.

### Why there is a launcher script

`tauri:build` is `apps/frontend/client/scripts/build_tauri.ts`, not `tauri build`, and each of the four
things below is a reason:

1. **The `@tauri-apps/*` stub must be off for every native target.** `vite.config.ts`
   replaces the Tauri packages with a throwing stub unless a native-build flag is
   set. The flag was called `TAURI_DESKTOP_BUILD`, which reads as desktop-only — so
   an Android or iOS build launched without it shipped stubbed Tauri packages, i.e.
   an app whose native calls throw. It is now `TAURI_NATIVE_BUILD`, set for every
   target. The old name is still accepted.

2. **`tauri` must resolve to the pinned workspace copy.** It is declared by the
   client, so `bunx tauri` from the repository root does not find it and downloads
   whatever the registry serves. Same failure mode as `bunx wrangler`.

3. **The dev-server port has to match `tauri.conf.json`.** Tauri v2 does not
   substitute environment variables into its config, so `build.devUrl` is a literal.
   If `PORT` disagrees with it, `tauri dev` opens a window on a port nothing is
   listening on — a blank webview that names neither file. The launcher detects the
   mismatch and refuses. The default is 5173, in one place:
   `apps/frontend/client/dev_ports.ts`.

4. **A host that cannot build the target says so.** `bun run tauri:build
   -- --target ios` on Linux names Xcode and macOS; `--target android` names a
   missing `ANDROID_HOME` or a missing NDK; a desktop build with no `cargo` names
   rustup. "tauri exits with a linker error" is a worse message than naming the
   missing prerequisite.

`bun run check:bundle` then verifies the artifact: `index.html` present, the
SvelteKit entry referenced, assets emitted, and — the part that matters — that the
bundle matches the mode it was built for. A browser bundle carrying real Tauri
imports and a native bundle still carrying the stub are both caught, because both
compile and both look fine.

`cargo check` in `src-tauri/` is enough to verify the Rust compiles. It needs GTK
and WebKitGTK, which on Nix means:

```bash
# pkg-config from the store, not the wrapper — the wrapper ignores PKG_CONFIG_PATH
export PATH="$(dirname "$(ls /nix/store/*pkg-config-0.29.2/bin/pkg-config | head -1)"):$PATH"
# Nix splits dev outputs; .pc files live under each package's lib/pkgconfig
export PKG_CONFIG_PATH=$(ls -d /nix/store/*-dev 2>/dev/null | while read -r d; do
  [ -d "$d/lib/pkgconfig" ] && echo "$d/lib/pkgconfig"
  [ -d "$d/share/pkgconfig" ] && echo "$d/share/pkgconfig"
done | sort -u | paste -sd:)
cd apps/frontend/client/src-tauri && cargo check
```

## Before your first release: rename it

`productName`, `identifier` and `version` are placeholders. They end up in your
bundle id, your install path and your signing identity, and changing them after a
first release is not free.

`apps/frontend/client/src-tauri/tauri.conf.json`:

```json
"productName": "Your App",
"identifier": "com.yourcompany.yourapp"
```

Also update `name` and `crate-type` in `Cargo.toml` to match. Full list in
[rename-checklist.md](rename-checklist.md).

## The security posture

Four decisions, each a way this could have gone wrong:

**`withGlobalTauri: false`.** The JS bridge is not injected into `window`. A
frontend that can reach `window.__TAURI__` can reach every command the shell
exposes, from any script it loads — including one a dependency introduced.

**Capabilities are allowlisted.** Tauri denies anything not in
`src-tauri/capabilities/default.json`. That file is the complete answer to "what
can the webview ask the shell to do":

```json
"permissions": ["core:default", "log:default"]
```

Two permissions, for a shell that needs two. An empty capabilities directory would
also be defensible; this one is not empty because the log plugin has a caller.

**No commands are registered.** `src/lib.rs` registers none, so there is nothing
for a compromised dependency to call.

**A CSP with `connect-src` naming the host, not `*`.** This webview is the one
place page code can reach the network directly, and a wildcard would let any
injected script exfiltrate a session token to anywhere:

```
default-src 'self'; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost https:; frame-ancestors 'none'
```

`style-src` allows `'unsafe-inline'` because Svelte scopes styles with inline
`style` attributes. `script-src` does not allow `unsafe-eval`; Vite's dev server
needs it, but that is served from `devUrl`, which this policy does not govern.

## What is deliberately absent

Each documented in `src-tauri/README.md`, and each yours to add:

- **No updater.** An updater needs a signing keypair and a release endpoint that
  belong to whoever ships the app. The source project shipped both, with real keys.
- **No signing keys**, and therefore no key material of any kind in this
  repository.
- **No sidecars.** None is needed to run this client, and a sidecar is a binary
  the template author chose.
- **No opener plugin.** The source project used it to launch external URLs. This
  one does not, so granting it would be a capability with no caller.

An unused plugin in a template is an attack surface the next person has to audit
instead of delete.

## Adding an updater

Three parts, and all three are yours:

1. **A signing keypair.** Generate it; never commit it. Add the public half to
   `tauri.conf.json` under `plugins.updater.pubkey`, and put the private half in
   your secret store (see [secrets.md](secrets.md)).
2. **A release endpoint** that serves the signed artifact and its signature. A
   static bucket plus a signed manifest is enough.
3. **The plugin**, with `tauri-plugin-updater` and the `updater:default` capability.

## Mobile

The same `src/lib.rs` builds for iOS and Android — it is a `staticlib`, not only a
binary, so the mobile entry point is the same function.

```bash
bun run --cwd apps/frontend/client tauri android init
bun run --cwd apps/frontend/client tauri ios init
```

Both generate a `gen/` directory, which **is committed** — without it a fresh
clone cannot build for mobile.

Note the `--cwd`: `tauri` is a dependency of the client, so `bunx tauri` from the
repository root would fetch a different version from npm. Every `tauri` invocation
here goes through the client's own `node_modules/.bin`.

Building for mobile needs the Android NDK and Xcode. Neither is present in the
environment this documentation was written in, so **the mobile path is documented and
structured but has not been built here.** The desktop path was also not built there:
`cargo` is absent. See [capability-matrix.md](capability-matrix.md).

Build through the launcher so the native-build flag is set:

```bash
bun run tauri:build -- --target android
```

Origins for the mobile webview are already in the API's allowlist:

```ts
export const TAURI_WEBVIEW_ORIGINS = [
  'tauri://localhost',      // Linux, macOS
  'http://tauri.localhost', // Windows
  'https://tauri.localhost',
];
```

They are listed explicitly rather than as a `localhost` wildcard, so a plain
browser on localhost gains nothing from the native client's allowance.

## Authentication

A Tauri webview's origin is `tauri://localhost`, which is a different **site** from
your API. The session cookie is never attached.

So the client presents the session token as a bearer token instead:

```ts
import { setApiTokenProvider } from '#lib/services/api_client.ts';

const { data } = await invoke<{ token?: string }>('get_session_token');
setApiTokenProvider(() => data.token);
```

A browser never calls this and keeps using the cookie. `ApiClient` sends
`credentials: 'include'` either way, which is harmless when there is no cookie to
send and correct in a browser.

## Native logs

`tauri-plugin-log` forwards into the same NDJSON file the other producers write,
so one `bun run logs` covers the app and the Worker. See [logs.md](logs.md).

## Not verified here

Stated plainly rather than left for you to discover. See
[capability-matrix.md](capability-matrix.md) for the full table.

- **Desktop bundles.** No Tauri bundle was produced. `cargo` is not installed in the
  environment this documentation was written in, and the launcher says so by name.
- **Mobile builds.** Need the Android SDK/NDK and Xcode.
- **`cargo clippy`.** Not installed in that environment.
- **Code signing.** No keys are shipped, so nothing is signed.
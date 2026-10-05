# apps/frontend/native — the static native client

## Purpose and runtime

A **static SvelteKit application** plus a **Tauri shell**, in one package:

| Half | What it is | Where it runs |
|---|---|---|
| `src/**` | A SvelteKit app built by `@sveltejs/adapter-static` into `build/` | Inside the Tauri webview, and in a plain browser during `native:dev` |
| `src-tauri/**` | A Rust crate — one window, three plugins, one command | As a desktop process on Linux, macOS and Windows, and as an Android or iOS app |

It exists because a desktop client has a different answer to "how do I reach the
API" and "where does my credential live" than a browser does, and neither answer
belongs in a shared package:

- the web app renders per request against a session cookie the browser holds;
- this app is **prerendered to files that ship inside the binary**, and carries a
  bearer token on every call.

So `apps/frontend/client` keeps SSR and this app stays static. Neither was traded
away for the other. Everything they share — the notes screen, the account service,
the session service, the device-authorization flow, the sample-encode screen —
comes from `@starter/features`, unmodified. There is one notes feature in this
repository and this package renders it with a different transport.

### The one place a shell differs from a browser: media

`/jobs` fetches an encoded result through the transport and plays it from a Blob.
A browser could get away with `<video src="/api/jobs/:id/output">`, because the
session cookie rides along. This window has no cookie jar and its credential is a
bearer token, so a media element's own request would go out anonymous and answer
401. Fetching through `createBearerTransport`'s byte path puts the credential in a
**header**, which is the only place it ever appears: not in the URL, not in a
`Referer`, not in a proxy log. There is no capability URL to mint, store and
revoke, and signing out stops the next fetch.

`src/lib/platform/app_activity.ts` is the other half of the lifecycle. A window
behind another one still reports itself `visible`, so the poll is stopped by
visibility **and** focus, and resumed by either.

## Setup and configuration

Nothing here is required to run the web lanes. The native lanes need their own
prerequisites and name them: run `bun run native:doctor`.

| Variable | Where | Meaning |
|---|---|---|
| `VITE_NATIVE_API_ORIGIN` | build time | Absolute **https** origin of the deployed API. A packaged build with no value **refuses to build**, and it refuses at the *build* rather than at the first request — there is no default, because a client pointed at a loopback port starts successfully and then signs nobody in. The launcher and Vite read the same value through `@starter/schemas/native`, and the launcher's value also generates the CSP's `connect-src`. |
| `VITE_NATIVE_CLIENT_ID` | build time | The device-authorization client id. **Public**, and documented as such in `src/lib/runtime/config.ts`: it is compiled into a binary anybody can unpack, so treating it as a secret is how a template grows a client secret nobody can rotate. |
| `NATIVE_DEV_PORT` | run time | The dev server the shell loads. Default `1420`. Deliberately not `PORT`, which the web app already owns. |
| `NATIVE_DEV_HOST` | run time | Address the dev server binds. `127.0.0.1` by default; a phone needs `0.0.0.0`, which is set for you by `--host`. |
| `VITE_NATIVE_DEV_API_HOST` | build time | The development machine's address, for a phone whose `localhost` is the phone. Set by `native … dev --host <address>`, read by `resolveApiOrigin`, and **refused** in a packaged build — see `docs/native.md`. |

### Which environment a packaged build targets

`VITE_NATIVE_API_ORIGIN` is **not** a workflow detail. A signed binary cannot be
re-pointed afterwards, so the origin a release is built against is part of the
resolved deployment target: `nativeApiOrigin` in
`resolveTarget(environment)`, configured with

```bash
bun run deploy:configure -- --env staging --native-api-origin https://staging.example
```

and refused, before any mutation, when it is not an absolute `https` URL with no path.
The release workflow builds against the selected environment's value, so "the app"
can never be one environment's client wearing another environment's name. A missing
value is **not** defaulted to the web app's origin: a client pointed at the wrong
environment is a valid credential channel pointed at someone else's data.

Validation of the origin is a unit-tested function, not a convention:
`src/lib/runtime/config.test.ts` refuses a path, a query, a non-http scheme, a
missing production value and a development build pointed at a non-loopback host.

## Commands

Run from the **repository root** unless noted. The native commands are not in
`bun run build` or `bun run test`, so nobody paying for the web app pays for a
desktop toolchain.

| Command | Working directory | What it does |
|---|---|---|
| `bun run native:doctor` | root | Reports what this host can build. Exit 3 when a prerequisite is missing. |
| `bun run native:dev` | root | `tauri dev`: the static app plus the shell. Defaults to the loopback dev origin when `VITE_NATIVE_API_ORIGIN` is unset. |
| `bun run native:build` | root | `tauri build`: a release binary. **Requires `VITE_NATIVE_API_ORIGIN`** — the launcher resolves it and refuses to start without one. |
| `bun run native:build -- --no-bundle` | root | The binary without an installer: the honest scope for a machine with no signing credentials. |
| `bun run native:doctor -- --platform android` | root | The Android prerequisites: SDK, compileSdk platform, NDK, JDK, `adb`, rustup targets. Exit 3 when one is missing. |
| `bun run native:doctor -- --platform ios` | root | The iOS prerequisites: macOS, full Xcode, `xcode-select`, rustup targets. Exit 3 on any other host. |
| `bun run native:android -- init --ci` | root | `tauri android init`: writes the generated Gradle project into the gitignored `src-tauri/gen/android/`. |
| `bun run native:android -- build --debug --apk --target aarch64 --ci` | root | A debug APK. `--target` takes an **ABI**, never a Rust triple. |
| `bun run native:android -- build --aab --ci` | root | A release bundle. |
| `bun run native:android -- run --release` | root | Install and launch on a connected device or emulator. |
| `bun run native:android -- dev --host <ip> "<device>"` | root | Development on a physical phone: the dev server and the API origin both move to `<ip>`. |
| `bun run native:ios -- init --ci` | root | `tauri ios init`. **macOS with full Xcode only**; elsewhere this exits 3. |
| `bun run native:ios -- build --target aarch64-sim --ci` | root | A simulator build. The CLI's default target is the *device*, so a simulator lane must say so. |
| `bun run native:ios -- build --export-method app-store-connect --archive-only --ci` | root | A signed archive for App Store Connect. |
| `bun run build` | `apps/frontend/native` | The static frontend only |
| `bun run check:bundle` | `apps/frontend/native` | Asserts the built bundle has no server code, and the web bundle has no native imports |
| `bun run check:artifacts -- <dir> [<dir> …] --origin <url> --revision <sha> --platform android\|ios` | `apps/frontend/native` | Asserts every `.apk`/`.aab`/`.ipa` in **every** directory names its target, revision and signing marker, and contains the expected API origin and no other |
| `bun run check:artifacts -- --name <platform> <target> <ext> <signed\|unsigned>` | `apps/frontend/native` | Prints the one spelling of an artifact name, so a workflow renames with the same function that later checks it |
| `bun run test` | `apps/frontend/native` | Unit lane: config, transport (JSON **and** byte path), vault, URL allowance, window activity, bundle control |
| `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` | `apps/frontend/native/src-tauri` | The Rust shell |

## Validation

| Lane | Command | Nonzero count asserted by |
|---|---|---|
| Frontend build | `bun run --cwd apps/frontend/native build` | The adapter is `strict`, so an unprerenderable route fails the build |
| Bundle separation | `bun run --cwd apps/frontend/native check:bundle` | `apps/frontend/native/scripts/check_bundle.test.ts`, and the command itself |
| Unit | `bun run --cwd apps/frontend/native test` | Bun's own summary |
| Rust | `cargo fmt/clippy/test` in `src-tauri` | `cargo test`'s own summary; the crate has a real unit test |
| Desktop binaries | `.github/workflows/native.yml` `desktop` | The artifact step fails when no binary was produced |
| Mobile argv and refusals | `bun run --cwd scripts test` (`tests/native_mobile.test.ts`) | Asserted on a machine with no SDK: exact argv, wrong flags, iOS on Linux |
| Committed mobile config | `bun run --cwd scripts test` (`tests/mobile_platform_config.test.ts`) | No cleartext/ATS exception, no `infoPlist`, no window minimum |
| Lifecycle | `bun run --cwd apps/frontend/native test` (`app_lifecycle.test.ts`) | Suspend, resume, offline, disposal, on a real `EventTarget` |
| Lifecycle decision | `bun run --cwd apps/frontend/native test` (`app_lifecycle_view_model.test.ts`) | When a refresh is automatic, and what is rendered while it is not |
| Artifacts | `bun run --cwd apps/frontend/native test` (`check_artifacts.test.ts`) | Real ZIP containers, a corrupted fixture, a wrong origin, a wrong revision |
| Android APK/AAB + emulator launch | `.github/workflows/native.yml` `android` | `adb install` + `am start` + `dumpsys`; the induced-failure step proves exit codes propagate |
| iOS simulator build + launch | `.github/workflows/native.yml` `ios` on `macos-14` | `xcrun simctl install` + `launch` |
| Signed artifacts | `.github/workflows/native-release.yml` | `preflight` fails naming any unset secret before a build starts |

What is **not** claimed here: that the **desktop** packaged app was launched. CI
builds the binary on three platforms and does not run it. The mobile jobs *do*
launch — an Android emulator and an iOS simulator — and they say so in their own
job summaries. Neither lane is credited with an authenticated sign-in: this
template ships no deployment, so the steps that need one are recorded as **not
run** rather than skipped silently. `docs/capability-matrix.md` keeps the split per
revision.

## Boundaries

- `src/lib/platform/**` is the only directory that may import `@tauri-apps/*`. It is
  classified `native-bridge` by `bun run guard`, and a page that reaches for the API
  itself is a violation.
- This package may not import `@starter/database`, `@starter/auth`, `drizzle-orm`,
  `better-auth`, `cloudflare:*`, `node:*` or `bun:*`. There is no server plane here.
- It may not import `apps/frontend/client` by relative path. The shared code it
  needs is published by `@starter/features` and `@starter/platform`.
- `src-tauri/target/**` and `src-tauri/gen/**` are build output. So are the Android
  and Xcode projects the Tauri CLI generates; they are regenerated, not reviewed.

See [docs/native.md](../../../docs/native.md) for the sign-in flow, the vault, the
capability set and what a release would still need. The shell has its own
[README](src-tauri/README.md).
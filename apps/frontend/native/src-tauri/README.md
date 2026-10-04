# apps/frontend/native/src-tauri — the Tauri shell

## Purpose and runtime

A Rust crate that compiles to a desktop process **or to an Android or iOS app**:
one window, a secure context, three plugins and one command. Nothing else.

The mobile targets reuse this crate unchanged. `#[cfg_attr(mobile,
tauri::mobile_entry_point)]` on `run()` is already there and is the only Rust
difference between a desktop binary and a phone app — which is the point of
declaring the crate as a `lib` with `staticlib`/`cdylib`/`rlib` in `Cargo.toml`
rather than as a `bin` only. Mobile adds *tooling* (an SDK, a generated Gradle or
Xcode project, an ABI vocabulary) and no new Rust code.

It is deliberately the smallest thing that can run the static bundle next to the
application, because every plugin in a template's shell is attack surface the next
person has to audit instead of delete. There is **no updater, no sidecar and no
signing material**, and there is no placeholder for them: an updater needs an
endpoint and a keypair that belong to whoever ships the app.

Recovered selectively from `snapshot/tauri` (4ca9d1b). What came back is the neutral
identity, the icon set and the notes on why each configuration value is what it is;
what did not come back is the old API split, the `https:` CSP, the mobile `.ok()`
and the plugin list.

## Setup and configuration

| File | What it decides |
|---|---|
| `tauri.conf.json` | Product name, identifier, window, CSP, bundle, and the dev URL. `withGlobalTauri: false` — the JS bridge is **not** injected into the page. |
| `capabilities/default.json` | The complete set of native permissions the webview has: `core:default`, `opener:allow-open-url`, `stronghold:default`. |
| `Cargo.toml` / `Cargo.lock` | Exact dependency pins. `--locked` everywhere; a drifting resolver is how a desktop build fails for reasons unrelated to the change under review. |
| `rust-toolchain.toml` | Channel `1.98.1` with clippy and rustfmt, shared with `apps/backend/media` so a lint difference between the two is never a toolchain artefact. |
| `bundle.android` | `minSdkVersion: 24`, `versionCode: 1`, and `debugApplicationIdSuffix: ".debug"` so a debug APK installs beside a release one instead of replacing it. |
| `bundle.iOS` | `minimumSystemVersion` and `bundleVersion`. `developmentTeam` and `infoPlist` are deliberately **absent**: a team is a credential of whoever ships the app (the CLI reads `APPLE_DEVELOPMENT_TEAM` from the environment), and a committed `infoPlist` is where an ATS exception would live. |

`app.windows[]` declares **no** `minWidth` or `minHeight`. Tauri applies window
configuration to a phone as well as to a desktop, where the "window" is the
screen, so a desktop minimum is a desktop assumption and produces a horizontally
scrolling view on a narrow phone. `scripts/tests/mobile_platform_config.test.ts`
asserts this, and asserts that the committed config names none of
`usesCleartextTraffic`, `networkSecurityConfig`, `NSAppTransportSecurity`,
`NSAllowsArbitraryLoads`, `NSAllowsLocalNetworking` or `NSExceptionDomains`.

Generated projects (`gen/android`, `gen/apple`) are **not** committed. They are
build products of `tauri.conf.json` and `Cargo.toml`, gitignored, excluded from
project discovery by `GENERATED_TREES`, and recreated by
`bun run native:android -- init --ci` / `bun run native:ios -- init --ci`.

**Change `productName` and `identifier` before your first release.** They are written
into every user's bundle id, install path and signing identity.

Linux needs the WebKitGTK development package (`libwebkit2gtk-4.1-dev` on
Debian/Ubuntu). `bun run native:doctor` checks for it by asking `pkg-config`, so the
failure names a package rather than a crate.

## Commands

Run from this directory, or through the root scripts that resolve the pinned CLI:

```bash
cargo fmt --check                              # formatting
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked                            # the vault key derivation
cargo build --release --locked                 # the binary, without the frontend
bun run native:build -- --no-bundle            # from the root: frontend + shell

# Android — needs the SDK, an NDK and a JDK; `bun run native:doctor -- --platform
# android` names whichever is missing.
bun run native:android -- init --ci
bun run native:android -- build --debug --apk --target aarch64 --ci
bun run native:android -- build --aab --ci

# iOS — macOS with full Xcode only, because `tauri ios` is not compiled into a
# non-macOS build of the CLI. Anywhere else this exits 3 naming the runner.
bun run native:ios -- init --ci
bun run native:ios -- build --target aarch64-sim --ci
```

Mobile targets are **ABIs and architectures**, never Rust triples:
`aarch64`, `armv7`, `i686`, `x86_64` for Android and `aarch64`, `aarch64-sim`,
`x86_64` for iOS. The triples the doctor asks `rustup target add` for are in
`scripts/src/native/mobile.ts`, and passing a triple to `--target` is refused with
that list.

`cargo build` on its own needs `../build` to exist — `build.rs` fails with a message
about the frontend rather than a confusing "frontendDist does not exist".

## Validation

| Claim | How it is proved |
|---|---|
| It compiles | `.github/workflows/native.yml`, `desktop` job, on Ubuntu, macOS and Windows. An artifact step fails when no binary was produced. |
| It is formatted and lint-clean | The same workflow's `rust` job: `cargo fmt --check`, clippy with warnings denied, `cargo test --locked` with the passing count asserted. |
| Its capability set is the one it claims | `cargo check` compiles `build.rs`, which validates `tauri.conf.json` and `capabilities/default.json` against the registered plugins. A permission for a plugin that is not registered fails the build. |
| It has a real test | `cargo test` runs four unit tests on `vault_key`; the workflow refuses a run that reports no passing tests. |
| It compiles for Android and iOS | `.github/workflows/native.yml`, `android` and `ios` jobs. Both prove the launcher propagates a real failure first, by breaking the linker through an environment variable rather than by editing a tracked file. |
| The mobile config is the one it claims to be | `bun run --cwd scripts test` — `tests/native_platform_config.test.ts` and `tests/mobile_platform_config.test.ts`. Credential-free, no SDK. |

**Not proved here:** that the packaged **desktop** application launches, and that
either mobile app performs an authenticated request against a deployed API. The
mobile lanes do install and launch on an emulator and a simulator, and their job
summaries record which of signing, physical-device and store distribution were
**not** performed. See [docs/native.md](../../../../docs/native.md) and
[docs/capability-matrix.md](../../../../docs/capability-matrix.md).

## Boundaries

- This crate may not import `apps/**`, `scripts/**` or any `@starter/*` package. It
  has no TypeScript dependencies at all; the only boundary it has with the frontend
  is the custom protocol serving `../build`.
- `withGlobalTauri: false` and no global command registration: the only commands the
  page can reach are the plugins' and the one named below.
- One application command, `vault_snapshot_path`. Application commands are not
  routed through the capability ACL, so it returns a directory and nothing else.
- Rust is not parsed by `bun run guard`. Cargo lanes are the authority for this
  crate; the guard's job is to keep `src-tauri/**` out of the TypeScript graph.
- The parent package is [the native client](../README.md); the canonical guide is
  [docs/native.md](../../../../docs/native.md).
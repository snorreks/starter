# apps/frontend/native/src-tauri — the Tauri shell

## Purpose and runtime

A Rust crate that compiles to a desktop process: one window, a secure context, three
plugins and one command. Nothing else.

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
```

`cargo build` on its own needs `../build` to exist — `build.rs` fails with a message
about the frontend rather than a confusing "frontendDist does not exist".

## Validation

| Claim | How it is proved |
|---|---|
| It compiles | `.github/workflows/native.yml`, `desktop` job, on Ubuntu, macOS and Windows. An artifact step fails when no binary was produced. |
| It is formatted and lint-clean | The same workflow's `rust` job: `cargo fmt --check`, clippy with warnings denied, `cargo test --locked` with the passing count asserted. |
| Its capability set is the one it claims | `cargo check` compiles `build.rs`, which validates `tauri.conf.json` and `capabilities/default.json` against the registered plugins. A permission for a plugin that is not registered fails the build. |
| It has a real test | `cargo test` runs four unit tests on `vault_key`; the workflow refuses a run that reports no passing tests. |

**Not proved here:** that the packaged application launches. See
[docs/native.md](../../../../docs/native.md).

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
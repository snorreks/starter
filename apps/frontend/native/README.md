# apps/frontend/native — the static native client

## Purpose and runtime

A **static SvelteKit application** plus a **Tauri shell**, in one package:

| Half | What it is | Where it runs |
|---|---|---|
| `src/**` | A SvelteKit app built by `@sveltejs/adapter-static` into `build/` | Inside the Tauri webview, and in a plain browser during `native:dev` |
| `src-tauri/**` | A Rust crate — one window, three plugins, one command | As a desktop process on Linux, macOS and Windows |

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
| `bun run build` | `apps/frontend/native` | The static frontend only |
| `bun run check:bundle` | `apps/frontend/native` | Asserts the built bundle has no server code, and the web bundle has no native imports |
| `bun run test` | `apps/frontend/native` | Unit lane: config, transport (JSON **and** byte path), vault, URL allowance, window activity, bundle control |
| `cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` | `apps/frontend/native/src-tauri` | The Rust shell |

## Validation

| Lane | Command | Nonzero count asserted by |
|---|---|---|
| Frontend build | `bun run --cwd apps/frontend/native build` | The adapter is `strict`, so an unprerenderable route fails the build |
| Bundle separation | `bun run --cwd apps/frontend/native check:bundle` | `apps/frontend/native/scripts/check_bundle.test.ts`, and the command itself |
| Unit | `bun run --cwd apps/frontend/native test` | Bun's own summary |
| Rust | `cargo fmt/clippy/test` in `src-tauri` | `cargo test`'s own summary; the crate has a real unit test |
| Desktop binaries | `.github/workflows/native.yml` | The artifact step fails when no binary was produced |

What is **not** claimed: that the packaged app was launched. CI builds the binary
on three platforms and does not run it — see `docs/native.md` for why, and for what
would be needed to.

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
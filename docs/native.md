# Native: desktop client, device sign-in and the vault

The canonical guide for `apps/frontend/native`. The package
[README](../apps/frontend/native/README.md) says what the project is and how to run
it; this says why each decision is the way it is, and what is **not** claimed.

## Why a second frontend at all

The web application is a Cloudflare Worker: it renders HTML per request because the
page it renders depends on a session cookie only the server can read. A desktop
client has the opposite shape — a file inside a binary, a token in the front end, an
API on another origin — and nothing for a server to render per request. So:

| | `apps/frontend/client` | `apps/frontend/native` |
|---|---|---|
| Adapter | `@sveltejs/adapter-cloudflare` | `@sveltejs/adapter-static` |
| Rendering | SSR per request | Prerendered once at build time |
| Session | `HttpOnly` cookie | Bearer token, memory by default |
| Where it runs | A deployed Worker | A desktop process |

Neither was traded away for the other. What they share is the presentation and the
client contracts: `@starter/features` holds the notes screen, the account service,
the session service and the device-authorization flow, and `@starter/platform` holds
the four interfaces a host implements — `ApiTransport`, `SessionStore`,
`Navigation`, `ExternalBrowser`. The web host implements the first two with a
relative URL and a cookie; the native host implements them with an absolute origin,
a header, a vault and the system browser. Everything between those two points is one
copy, and `bun run guard` fails the build if a second one appears.

## Sign-in: device authorization, in the user's own browser

The client never asks for a password. A desktop app that collects one has the
password. Instead, [RFC 8628](https://datatracker.ietf.org/doc/html/rfc8628):

1. `POST /api/auth/device/code` with a **public** client id. The server answers with a
   device code, a short user code, and `verification_uri_complete`.
2. The client hands that URL to `ExternalBrowser`, which opens the **system** browser.
   Not a webview: a webview rendering a login page is a phishing surface with the
   app's chrome around it, and the user's browser already holds their account.
3. `POST /api/auth/device/token` is polled. The server's `interval` is the floor; a
   `slow_down` adds five seconds and keeps waiting; `access_denied` and
   `expired_token` are terminal.
4. The browser side is `apps/frontend/client/src/routes/device/**`: a signed-in page
   that claims the code and offers **Approve** and **Deny**.

The polling rules are `packages/frontend/features`' `DeviceAuthorizationService`, and
they are unit-tested there rather than in the shell — `interval`, `slow_down`,
`authorization_pending`, `access_denied`, `expired_token`, the expiry deadline and
cancellation are all asserted against a fake transport and an injected clock.

Four things this flow deliberately does not have:

- **No custom signed token.** The token `/device/token` returns is an ordinary Better
  Auth session token. `bearer()` turns it into the session a cookie would produce,
  and the same `getSession` call verifies it.
- **No client secret.** `client_id` is compiled into a binary anybody can unpack.
- **No in-app login form.** The webview never sees a credential prompt.
- **No scope grant.** `scope` is empty; the device flow grants exactly what a session
  grants.

The `/device` page is a **route on the web application**, not a URL the plugin
invented: `DEVICE_VERIFICATION_PATH` in `container.ts` is handed to the plugin, and
`worker_integration.test.ts` asserts the page renders and that `verification_uri`
points at it.

### The database

`device_codes` was created by migration `0001_early_captain_cross.sql`, when a native
client existed and was later removed. Re-enabling the plugin required **no new
migration**: `bun run db:generate` reports *"No schema changes, nothing to migrate"*,
and the columns are the plugin's own (`device_code`, `user_code`, `user_id`,
`expires_at`, `status`, `last_polled_at`, `polling_interval`, `client_id`, `scope`)
plus the adapter's audit pair. Applied migrations are never rewritten to match a
schema change; this one did not need one.

## Session persistence: Stronghold, opt-in, unlocked by the user

The default is **memory only**. A credential that survives a crash is a credential
somebody else can read, so nothing is written until the user ticks "remember me" and
types a passphrase.

| Question | Answer |
|---|---|
| Where does the token live? | A Stronghold snapshot under the app's data directory, addressed by a hex-encoded scope key. |
| What unlocks it? | A passphrase the user types. It is passed to `Stronghold.load`, used to derive the key, and dropped. Nothing on either side of the boundary stores it. |
| How is the key derived? | Argon2id, in `src-tauri/src/lib.rs`, with a fixed application salt. A per-installation random salt would be better; it cannot be read before the key exists, and the key is what it would be stored next to. Stated, not hidden. |
| What else could read it? | Nothing in this repository. No `localStorage`, no `sessionStorage`, no file in the data directory. |
| When is it removed? | On sign-out and on server-side revocation — see below. |
| What about a second account? | Refused until the first is signed out, so a second sign-in cannot leave a live credential behind unrevoked. |
| What about another environment? | Refused. The store is pinned to one origin at construction, so a staging token cannot survive a switch to production. |

Five behaviours are asserted in
`apps/frontend/native/src/lib/platform/vault_session_store.test.ts`, against a fake
port rather than a real vault: **locked** (reads nothing, refuses to write),
**wrong passphrase** (nothing unlocks), **expired** (removed, not returned),
**revoked** (cleared, including the deferred case), **environment switch** (refused
in all three operations).

Two properties of the pinned plugin are worth knowing, because both are silent:

- `Stronghold.load` **creates** the snapshot when the file does not exist, for any
  passphrase. So a wrong passphrase on a fresh install succeeds and yields an empty
  vault; a wrong passphrase on an existing install fails.
- Writes are not persisted until `save()`. The adapter saves after every mutation, so
  a "remember me" the app reports as stored is stored.

Sign-out is ordered deliberately: the **server** revokes the session first, then the
in-memory token goes, then the vault entry. A vault that cannot be written right now
(a locked vault after a restart) has its removal queued and applies it at the next
unlock — dropping it would leave a live credential on disk.

Tokens never appear in a message this repository logs: every error the vault path
constructs goes through `redactSecret`, and the store has no field that holds the
passphrase, so it cannot be read out of the object.

## Capabilities and CSP

`capabilities/default.json` is the complete answer to "what can this webview ask the
OS for":

| Permission | Why |
|---|---|
| `core:default` | The framework's own baseline. No filesystem, shell or network. |
| `opener:allow-open-url` | Hand **one** approval URL to the system browser. Not `opener:default`, which also launches applications and reveals files. |
| `stronghold:default` | The vault: create, read, delete records. No network, no peer-to-peer, no procedure execution. |

Absent, and each absence closes a door: no `shell:` (the snapshot's launcher could run
commands), no `http:`, no updater, no sidecar. `withGlobalTauri` is `false`, so the
page cannot reach `window.__TAURI__` at all.

The CSP names the one API origin in `connect-src`. The snapshot's was
`connect-src … https:`, which allows any injected script to exfiltrate a session
token to anywhere — the opposite of the point.

`tauri-plugin-path` is **not** a dependency. The snapshot path is chosen by one
application command, `vault_snapshot_path`, which resolves the app's own data
directory. A front end that could name a path could aim the vault anywhere.

## Keeping the two bundles apart

Two controls, one property:

- `bun run --cwd apps/frontend/client check:bundle` refuses `@tauri-apps/` in the
  deployed Worker bundle.
- `bun run --cwd apps/frontend/native check:bundle` refuses server markers in the
  native bundle (`cloudflare:workers`, D1 table and index names, `BETTER_AUTH_*`,
  `drizzle-orm`) **and** re-asserts the first property against the web bundle when it
  is present.

`bun run guard` adds the source-level half: only `src/lib/platform/**` may name the
Tauri API, and the whole native app may not reach `@starter/database`,
`@starter/auth`, `drizzle-orm`, `better-auth` or a Cloudflare binding.

## Desktop builds, and what is not claimed

`bun run native:build` and `.github/workflows/native.yml` produce an **unsigned
binary** on Ubuntu, macOS and Windows.

| Capability | State |
|---|---|
| Compiles on Linux, macOS, Windows | Proven by CI; artifacts are named with target, revision and the word `unsigned`. |
| Formatted, clippy-clean, unit-tested | Proven by CI (`rust` job), with the passing count asserted. |
| Signed installer, notarized `.dmg`, app-store upload | **Not implemented.** They need credentials this repository does not have, and a workflow that referenced them would fail for every contributor. |
| The packaged app **launching** | **Not proved.** CI builds; it does not run. |
| An authenticated workflow inside the shell | **Not proved end to end.** The flow is proven from both sides — device approval, bearer access, revocation — against the built Worker; the last mile needs a signed-in shell. |
| Android, iOS | **Not implemented.** Out of scope for this change; `docs/rename-checklist.md` and the round-2 review record what it needs. |

To check a launch yourself:

```bash
bun run native:build -- --linux --no-bundle
./apps/frontend/native/src-tauri/target/release/starter
```

with `VITE_NATIVE_API_ORIGIN` pointing at a deployment you control.

## Mobile, and who owns it

The shell is written so a mobile build is a configuration change rather than a
rewrite: `src/lib.rs` has a `#[cfg_attr(mobile, tauri::mobile_entry_point)]` entry
point, the window has no desktop minimum width, and the app HTML asks for
`viewport-fit=cover`. The plugins chosen here (opener, stronghold) support both
mobile platforms.

What is **not** here: `tauri android init`, `tauri ios init`, the generated Gradle
and Xcode projects, the signing identities, and the device-reachable dev URL — a
phone's `localhost` is not a development machine's `localhost`. Those belong to the
change that adds mobile, and that change owns this workflow's mobile lanes rather
than creating a second one.

## Also read

- [docs/architecture.md](architecture.md) — the planes, and why this app is `browser`
- [docs/auth.md](auth.md) — the account lifecycle, and what the plugins added
- [docs/cloudflare.md](cloudflare.md) — the API this client talks to
- [docs/toolchain.md](toolchain.md) — the Rust and Tauri pins
- [docs/capability-matrix.md](capability-matrix.md) — what was verified, and where
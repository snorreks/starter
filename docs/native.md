# Native: desktop and mobile clients, device sign-in and the vault

The canonical guide for `apps/frontend/native`. The package
[README](../apps/frontend/native/README.md) says what the project is and how to run
it; this says why each decision is the way it is, and what is **not** claimed.

Desktop (Linux, macOS, Windows), Android and iOS are built from the same static
bundle by the same pinned Tauri CLI. They are not the same *capability*: an
emulator launch, a signed archive and a physical device run are three separate
things with three separate proofs, and this document keeps them in three separate
rows rather than under one "mobile works" heading.

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

`native:dev` and `native:build` normalize `VITE_NATIVE_API_ORIGIN` from the
launch environment and generate the CSP's `connect-src` for that origin. Development
defaults to `http://127.0.0.1:5173`; builds require an explicit HTTPS origin.
The launcher passes the same origin to Vite and the CSP to Tauri through `--config`,
for both `csp` and `devCsp`. Vite refuses a mismatch. Set the variable in the launch
environment when using these commands; their resolved value takes precedence over
Vite `.env` files. The checked-in CSP permits only local IPC until the launcher
adds the API origin. The snapshot's was
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
| Signed installer, notarized `.dmg`, app-store upload | **Not implemented here.** `.github/workflows/native-release.yml` implements the signing lanes; they need credentials this repository does not have, and a workflow that referenced them on `pull_request` would fail for every contributor. |
| The packaged app **launching** | **Not proved on desktop.** CI builds; it does not run. The mobile lanes below *do* launch, on an emulator and a simulator. |
| An authenticated workflow inside the shell | **Not proved end to end.** The flow is proven from both sides — device approval, bearer access, revocation — against the built Worker; the last mile needs a signed-in shell and a deployed API. |

To check a launch yourself:

```bash
bun run native:build -- --linux --no-bundle
./apps/frontend/native/src-tauri/target/release/starter
```

with `VITE_NATIVE_API_ORIGIN` pointing at a deployment you control.

## Mobile: the CLI vocabulary, and where it came from

`bun run native:android` and `bun run native:ios` run the pinned Tauri CLI's own
mobile subcommands. Every flag they accept was read out of that CLI, not recalled:

| | Android | iOS |
|---|---|---|
| Subcommands | `init`, `dev`, `build`, `run` | `init`, `dev`, `build`, `run` |
| `--target` values | `aarch64`, `armv7`, `i686`, `x86_64` (ABIs) | `aarch64`, `aarch64-sim`, `x86_64` (architectures) |
| Default target | all | `aarch64` — the **device**, not the simulator |
| Rust triples | `aarch64-linux-android`, `armv7-linux-androideabi`, `i686-linux-android`, `x86_64-linux-android` | `aarch64-apple-ios`, `aarch64-apple-ios-sim`, `x86_64-apple-ios` |
| Platform flags | `--apk`, `--aab`, `--split-per-abi` | `--export-method`, `--no-sign`, `--archive-only`, `--build-number` |

Two facts about the CLI shape the rest of this section follows from:

- **`--target` is never a Rust triple.** `tauri android build --target
  x86_64-linux-android` is a usage error, and so is `tauri ios build --target
  aarch64-apple-ios`. The triples live in `scripts/src/native/mobile.ts` because
  the doctor asks `rustup target add` for them, and because the mapping should be
  one table rather than a paragraph of prose.
- **`tauri ios` is compiled only into the CLI's macOS build.** On Linux it is
  `error: unrecognized subcommand 'ios'` with exit 2, which a caller reading exit
  codes alone would record as a usage mistake. `bun run native ios …` therefore
  refuses on a non-macOS host with **exit 3**, naming the macOS runner — and a
  Linux build is never credited with an iOS build.

Wrong flags are refused rather than forwarded, per platform *and* per subcommand:
`tauri android dev --apk` is a usage error from clap, and `tauri android build
--no-sign` is an iOS flag. `scripts/tests/native_mobile.test.ts` asserts the exact
argv and the refusals on a machine with neither SDK installed.

## Android prerequisites, and where the numbers come from

```bash
bun run native:doctor -- --platform android
```

asks, by running each tool: `ANDROID_HOME` (or `ANDROID_SDK_ROOT`) and whether it
exists, the installed platform, the NDK, a **JDK** (not a JRE — Gradle compiles the
Android module), `adb`, and the rustup targets the requested ABIs need.

| Pin | Value | Where it comes from |
|---|---|---|
| `compileSdk` / `targetSdk` **API level** | 37 | `SDK_VERSION` in `crates/tauri-cli/src/mobile/android/mod.rs` |
| Installable platform package | `platforms;android-37.2` | `repository2-3.xml`: the newest 37.x on the stable channel |
| NDK | `ndk;29.0.13846066` | `NDK_VERSION` in the same file |
| `minSdkVersion` | 24 | `bundle.android.minSdkVersion` in `tauri.conf.json` |

The API level is **not** a package name, and conflating the two is a failure CI
already made: Android publishes platform packages under minor-versioned names
(`android-36.1`, `android-37.0`, `android-37.1`, `android-37.2`,
`android-37.2-beta1`…), there is no bare `platforms;android-37`, and
`sdkmanager` answers `Warning: Failed to find package 'platforms;android-37'`.
Each of those archives unpacks into `platforms/android-<major>.<minor>/`, so a
correctly provisioned SDK contains `android-37.2` and **no** `android-37`
directory at all — which is why `bun run native:doctor -- --platform android`
compares the API **major** level instead of matching a directory name. Both
constants live side by side in `scripts/src/native/mobile.ts` with the evidence
attached.

So, to provision a host by hand:

```bash
sdkmanager "platform-tools" "platforms;android-37.2" "ndk;29.0.13846066" \
          "emulator" "system-images;android-34;google_apis;x86_64"
```

The generated Gradle project is **not committed**. `tauri android init` writes
`src-tauri/gen/android/`, which is gitignored, excluded from project discovery by
`GENERATED_TREES` in `scripts/src/guards/policy.ts`, and regenerated by
`bun run native:android -- init --ci`. Regenerate rather than merge it: it is a
build product of `tauri.conf.json` and `Cargo.toml`, and a hand-edited copy of one
is a file that disagrees with its own source the next time either changes.

## One transitive pin, and why it cannot be upgraded

`libc` is held at **0.2.189** in `apps/frontend/native/src-tauri/Cargo.lock`, and
that is the only pin in this repository that is not an `=` in a `Cargo.toml`.

`libc 0.2.190` gated `mach_task_self()` behind `#[cfg(target_os = "macos")]` — the
source says "Prohibited on iOS/tvOS/watchOS/visionOS". The unmaintained
`num_threads 0.1.7` routes `target_os = "ios"` to `apple.rs`, which calls exactly
that function, so the shell does not compile for `aarch64-apple-ios`:

```
error[E0425]: cannot find function `mach_task_self` in crate `libc`
   --> num_threads-0.1.7/src/apple.rs:34
error: could not compile `num_threads` (lib) due to 1 previous error
```

There is no upgrade path, which is why this is a pin rather than a wait:

- `num_threads` has had **no release since 0.1.7** (checked against the registry).
- `time` depends on it unconditionally, and `time` is reached by `cookie`,
  `plist`, `tauri-codegen` and `tauri-plugin-log`.
- `0.2.189` is the last release before the regression, and it satisfies
  `rustix`'s `^0.2.182`, so the whole tree resolves there.

```bash
cargo update -p libc --precise 0.2.189   # the only command that restores this
```

`scripts/tests/cargo_ios_pins.test.ts` is what keeps it pinned. A lockfile pin is
durable only until somebody runs `cargo update`; without the test, the next
routine update restores a broken iOS build and the symptom is a CI error naming a
crate this repository does not depend on.

The rule is conditional on `num_threads` being in the tree, not on a path list.
`apps/backend/media` carries `libc 0.2.190` today and is **fine** — nothing in its
tree reaches `num_threads` — and a rule that pinned every Rust crate would push an
unnecessary downgrade onto the one that has no problem.

## iOS prerequisites

```bash
bun run native:doctor -- --platform ios
```

requires macOS, `xcodebuild` (the full Xcode — the command line tools cannot build
an app) and a `xcode-select` path that is not `/Library/Developer/CommandLineTools`.
On any other host the first line is `MISS xcode` with that as the remedy, and the
command exits 3.

`tauri ios init` writes `src-tauri/gen/apple/`, gitignored and regenerated the same
way. `bundle.iOS.developmentTeam` is deliberately unset: it is a credential of
whoever ships the app, and the CLI reads `APPLE_DEVELOPMENT_TEAM` from the
environment instead. The archived Xcode project may be overridden per project
through `bundle.iOS.template` (an XcodeGen `project.yml`).

## A phone, and what `localhost` means there

A physical phone's `127.0.0.1` is the phone. That single fact decides three
separate things, and conflating them is how a phone build "works" on the
developer's desk and nowhere else.

1. **The dev server.** `NATIVE_DEV_HOST` is `127.0.0.1` by default. Passing
   `--host <address>` makes the launcher set it to `0.0.0.0` for the Vite server
   *and* export `VITE_NATIVE_DEV_API_HOST=<address>`, which moves the client's API
   origin to the same machine. Both happen in one place — `launchMobile` in
   `scripts/src/commands/native.ts` — and `--host` on anything but `dev` is refused.
2. **The API origin.** `resolveApiOrigin` allows plain HTTP in a development build
   to loopback, or to a host you named with `--host`, and refuses it everywhere
   else. The `dev` flag comes from the **subcommand**, not from an environment
   variable, so `bun run native:android -- build` cannot be talked into a LAN
   address: `nativeConfiguration` passes `dev: false` and `resolveApiOrigin`
   refuses the pair. A `build --debug` APK is `dev: false` too, which is why it
   still needs an `https` API.
3. **Cleartext.** The pinned CLI's own Gradle template sets
   `manifestPlaceholders["usesCleartextTraffic"] = "true"` **only in the `debug`
   build type**, and `"false"` for release. That is the whole mechanism, and it
   lives in the generated project, not in this repository.
   `scripts/tests/mobile_platform_config.test.ts` asserts that the committed
   configuration names none of `usesCleartextTraffic`, `networkSecurityConfig`,
   `NSAppTransportSecurity`, `NSAllowsArbitraryLoads`, `NSAllowsLocalNetworking`
   or `NSExceptionDomains`, and that `bundle.iOS.infoPlist` is unset so no ATS
   exception can be merged in. An ATS exception committed here is an ATS exception
   in the App Store binary.

**An iPhone against a plain-http development server** is the one case the above
does not cover: iOS enforces App Transport Security for a device build, where the
Android debug build type does not. Either serve the development API over https
(a tunnel is enough), or supply an ATS exception through
`bundle.iOS.infoPlist` pointing at a plist you keep out of the repository and
merge with `--config`. This template does not ship one.

## What a phone does while you are not looking

`src/lib/platform/app_lifecycle.ts` turns the platform's own events into three
states, `src/lib/viewmodels/app_lifecycle_view_model.ts` decides what each state
*means* — including the only moment a refresh is automatic — and `+layout.svelte`
owns the listeners and the markup. The split is the View -> ViewModel -> Services
rule applied to a platform concern: the View never asks *whether* it may refresh,
so a second screen cannot get that answer wrong a different way.

Three states, and nothing else:

| Phase | Cause | What the app does |
|---|---|---|
| `active` | visible, network believed up | — |
| `suspended` | `visibilitychange`, `pagehide`/`pageshow` | cancels outstanding work on the way out; refreshes on the way in |
| `offline` | `offline` (only `false` is acted on) | says so, once, and waits for a tap |

`navigator.onLine` is read only as a hint that something changed, never as an
answer: it reports `true` on a phone attached to a network with no route. Nothing
retries automatically, because a retry of a request that may already have been
received duplicates it.

The layout side is CSS, in `src/routes/+layout.svelte` and `src/app.css`:
`viewport-fit=cover` in `app.html`, `env(safe-area-inset-*, 0px)` applied to the
header and the main column, `100vh` followed by `100dvh` so the keyboard shrinks
the layout viewport, `flex-wrap` on the header nav, `overflow-wrap` on the user
email, and `overflow-x: hidden` on the body so an overflowing view fails a test
rather than scrolling. `tauri.conf.json` declares **no** `minWidth`/`minHeight`:
Tauri applies window configuration to a phone, and a desktop minimum is a desktop
assumption.

**Android back.** The generated `MainActivity` is `launchMode="singleTask"` and the
webview owns history, so back walks the app's own route stack and leaves the app at
the root. The emulator lane delivers `KEYCODE_BACK` twice and asserts the shell does
not hang.

**Stronghold on a phone** is a separate capability from Stronghold on a desktop and
is recorded as one in `docs/capability-matrix.md`. The rules — locked store reads
nothing, wrong passphrase unlocks nothing, scope per environment and per account,
sign-out removes and logout-revocation clears — are all in
`apps/frontend/native/src/lib/platform/vault_session_store.ts` and are
platform-independent. What a phone adds is the OS keychain interaction and the
process being frozen between uses, and that is a device observation.

## Artifacts

Every mobile artifact is named by one function, `artifactName` in
`apps/frontend/native/scripts/check_artifacts.ts`:

```
starter-<platform>-<target>-<first 12 of the source revision>-<signed|unsigned>.<apk|aab|ipa>
```

and then **verified**, not just renamed:

```bash
bun run --cwd apps/frontend/native check:artifacts -- \
  -- apps/frontend/native/src-tauri/gen/android/app/build/outputs/apk/debug \
     --origin "$VITE_NATIVE_API_ORIGIN" --revision "$GITHUB_SHA" --platform android
```

It refuses an artifact whose name does not carry its target, revision **and
signing marker**, one from a different revision or a different platform, a
directory with no package in it, a package with no frontend in it, a package that
does not contain the expected origin, and — the one that catches a real mistake —
a package containing a *second* origin. Namespace URIs (`http://www.w3.org/…`)
and RFC 2606 documentation hosts are excluded, because a check that fires on them
fails on every correct build and is the shortest route to deleting it.

Every directory on the command line is checked, and the results are combined.
`bun run native:android -- build --apk` and `… --aab` produce two directories, and
checking only the first would certify a release bundle nobody read. The reader is a small ZIP implementation with a CRC check, not a
shelled-out `unzip`: `unzip` is absent from a Nix dev shell half the time, and a
verification step that skips when its tool is missing is worse than no
verification.

`--name` prints the same spelling, so a workflow renames an artifact with the
function that later checks it. Two implementations of a naming scheme is how a lane
starts uploading files nothing can attribute.

## Mobile capabilities, stated separately

| Capability | Where it is proved | State |
|---|---|---|
| Android debug APK + release AAB build | `native.yml` `android` job | Lane exists; run it against a branch to fill the cell |
| Android installed and launched on an emulator | `native.yml` `android` job | Lane exists; same |
| Android back key | `native.yml` `android` job | Lane exists; same |
| iOS simulator build, unsigned | `native.yml` `ios` job, `macos-14` | Lane exists; same |
| iOS installed and launched on a simulator | `native.yml` `ios` job | Lane exists; same |
| Induced failure propagates from the CLI | both jobs | Lane exists; same |
| Signed AAB / archive | `native-release.yml` | Lane exists; needs `ANDROID_KEYSTORE_*` / Apple secrets |
| Physical device | nowhere | **Not implemented.** Needs a provisioned device and a human. |
| Google Play or App Store upload | nowhere | **Not implemented, deliberately.** A store credential in CI is a second authority with its own rollback story. |
| Authenticated sign-in and the notes path on a device | nowhere | **Not implemented.** Needs a deployed API; the steps are named in `docs/testing.md`. |

## Running it yourself

```bash
# Android, on a machine with the SDK, a JDK and the NDK
bun run native:doctor -- --platform android
bun run native:android -- init --ci
bun run native:android -- build --debug --apk --target aarch64 --ci
bun run native:android -- run --release        # install and launch on a device

# Android on a phone on the same network
bun run native:android -- dev --host "$(ip -4 addr show scope global | awk '/inet /{print $2}' | cut -d/ -f1 | head -1)" "Pixel 8"

# iOS, on macOS with full Xcode
bun run native:doctor -- --platform ios
bun run native:ios -- init --ci
bun run native:ios -- build --target aarch64-sim --ci
xcrun simctl install booted <the .app> && xcrun simctl launch booted com.example.starter
```

## Also read

- [docs/architecture.md](architecture.md) — the planes, and why this app is `browser`
- [docs/auth.md](auth.md) — the account lifecycle, and what the plugins added
- [docs/cloudflare.md](cloudflare.md) — the API this client talks to
- [docs/toolchain.md](toolchain.md) — the Rust and Tauri pins
- [docs/capability-matrix.md](capability-matrix.md) — what was verified, and where
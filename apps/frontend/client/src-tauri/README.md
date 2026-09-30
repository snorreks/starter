# Tauri shell configuration — notes on `tauri.conf.json`
#
# The rationale for each decision below lives here rather than in the JSON,
# because `tauri.conf.json` is validated against a closed schema: an unknown key —
# including a `"//"` comment — fails the build with an error that blames a CLI
# version mismatch rather than the actual cause. That cost a debugging cycle.
#
# **Neutral identity.** `productName`, `identifier` and `version` end up in the
# adopter's bundle id, install path and signing identity. A template must not ship
# another project's values, so all three are placeholders. Change them before your
# first release — see `docs/native.md`.
#
# **No updater section.** An updater needs a signing keypair and a release
# endpoint that belong to whoever ships the app. The source project shipped both,
# with real keys. `docs/native.md` explains how to add your own.
#
# **No sidecars.** A sidecar is a binary the template author chose. None is needed
# to run this client.
#
# **`withGlobalTauri: false`.** The JS bridge is not injected into the page. A
# frontend that can reach `window.__TAURI__` can reach every command the shell
# exposes, from any script it loads — including one added by a dependency.
#
# **CSP.** `connect-src` names the API host rather than using `*`. This webview is
# the one place page code can reach the network directly, and a wildcard there
# would let any injected script exfiltrate a session token to anywhere.
#
# `default-src 'self'` with no `unsafe-eval`. Vite's dev server needs eval for
# hot reload, but that is served from `devUrl`, which this policy does not govern;
# it applies to the packaged bundle.
#
# **Capabilities.** Every native permission this shell exposes is listed in
# `capabilities/default.json`. Tauri denies anything not listed there, so that
# file is the complete answer to "what can the webview ask the shell to do".
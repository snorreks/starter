// apps/frontend/client/src-tauri/src/lib.rs
//
// The shell: one window, one capability set, one log target.
//
// Three decisions worth stating, because each was a way to get this wrong:
//
//   1. **No updater, no signing keys, no sidecars.** The source project shipped
//      all three with real keys. An updater in a template needs an endpoint that
//      belongs to whoever runs it; a sidecar is a binary the author chose. Both
//      are the adopter's to add, and both are documented in docs/native.md.
//
//   2. **`withGlobalTauri: false`.** The JS bridge is not injected into the
//      page. A frontend that can reach `window.__TAURI__` can reach every command
//      the shell exposes from any script it loads — including one injected by a
//      dependency.
//
//   3. **Commands are not registered globally.** This file registers none, so
//      there is nothing for a compromised dependency to call. The capability
//      files below grant the two plugins the template uses, and nothing else.

/// Build and run the application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // Structured native logs. Without this, a packaged app's logs go to
        // stdout on a machine nobody can read them from.
        .plugin(tauri_plugin_log::Builder::new().build());

    #[cfg(desktop)]
    {
        builder
            .run(tauri::generate_context!())
            .expect("failed to start the native shell");
    }

    // On mobile the entry point is the same function; the `#[cfg]` above is what
    // stops the desktop branch from also compiling where `generate_context!` has
    // no meaning.
    #[cfg(mobile)]
    {
        builder.run(tauri::generate_context!()).ok();
    }
}

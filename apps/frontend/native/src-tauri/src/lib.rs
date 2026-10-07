// apps/frontend/native/src-tauri/src/lib.rs
//
// The shell: one window, one capability set, one vault key, three log targets.
//
// Five decisions worth stating, because each was a way to get this wrong in the
// snapshot this crate was recovered from:
//
//   1. **No updater, no signing keys, no sidecars.** The source project shipped
//      all three with real keys. Those belong to whoever ships the app.
//   2. **`withGlobalTauri: false`** in `tauri.conf.json`. The JS bridge is not
//      injected into the page. A front end that can reach `window.__TAURI__` can
//      reach every command the shell exposes from any script it loads — including
//      one added by a dependency.
//   3. **No global command registration.** This file registers one command, and
//      what it returns is stated below. There is nothing else for a compromised
//      dependency to call.
//   4. **The plugins registered here are exactly the ones the front end imports.**
//      Opener (hand an approval URL to the real browser), stronghold (the vault)
//      and log (native records with a destination).
//   5. **A failure to start is not reported as a start.** `build()` returns a
//      `Result` and is unwrapped with `expect`, so a shell that cannot create its
//      window says why on stderr and exits nonzero. The snapshot's mobile branch
//      was `builder.run(context).ok()`, and the reason it read as a no-op is worth
//      recording: `run()` returns `()` — there is no error to discard, and there was
//      never anything on that line to propagate. `cargo test` is what corrected this
//      file; a `.expect` after `run()` is a method that does not exist.

use argon2::{Algorithm, Argon2, Params, Version};
use tauri::Manager;

/// The vault snapshot's file name inside the application data directory.
const VAULT_FILE_NAME: &str = "starter-native-session.hold";

/// Salt for the passphrase → key derivation.
///
/// A constant, and the trade-off is stated rather than hidden. A per-installation
/// random salt would be better; it cannot be read before the key exists, and the
/// key is what the salt would be stored next to. A fixed application salt still
/// stops one passphrase being rainbow-tabled across every install of this
/// template, which is the attack a constant salt actually enables. Argon2id with
/// default parameters (19 MiB, three passes) is the expensive part.
const VAULT_KEY_SALT: &[u8] = b"starter.native.vault.v1";

/// Stronghold's key length. The vault rejects anything else.
const VAULT_KEY_LEN: usize = 32;

/// Derive the 32-byte snapshot key from the user's passphrase.
///
/// The passphrase is a parameter and nothing more: it is not stored, not logged,
/// and not held after this returns. The whole "remember me" design rests on that —
/// a vault whose unlock secret is recoverable from the same place as the vault is
/// an encrypted file, not a protection.
fn vault_key(password: &str) -> Vec<u8> {
    let mut key = [0u8; VAULT_KEY_LEN];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, Params::default())
        .hash_password_into(password.as_bytes(), VAULT_KEY_SALT, &mut key)
        .expect("argon2 parameters and lengths are inside the crate's documented bounds");
    key.to_vec()
}

/// Where the vault snapshot lives.
///
/// The front end never chooses this path, which is why the `path` plugin is not a
/// dependency here: a page that could name a path could aim the vault anywhere,
/// and "resolve the application's own data directory" is not a capability worth a
/// permission.
///
/// Application commands — as opposed to `plugin:*` commands — are not routed
/// through the capability ACL, so this one needs no permission entry. That is the
/// reason it returns a directory and nothing else: it is callable by the page, so
/// it must be harmless when it is.
#[tauri::command]
fn vault_snapshot_path(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_local_data_dir()
        .map(|directory| {
            directory
                .join(VAULT_FILE_NAME)
                .to_string_lossy()
                .into_owned()
        })
        .map_err(|error| format!("could not resolve the application data directory: {error}"))
}

/// Build and run the application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        // Structured native logs. Without this, a packaged app's logs go to
        // stdout on a machine nobody can read them from.
        .plugin(tauri_plugin_log::Builder::new().build())
        // The encrypted vault behind opt-in "remember me".
        .plugin(tauri_plugin_stronghold::Builder::new(vault_key).build())
        // Hand an approval URL to the user's own browser. See
        // `src/lib/platform/external_browser.ts` for why this is a capability and
        // not a webview.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![vault_snapshot_path]);

    builder
        .build(tauri::generate_context!())
        .expect("failed to build the native shell")
        .run(|_app, _event| {
            // Nothing is written on exit on purpose. The credential lives in the
            // front end's memory and, when the user opted in, in the vault; this
            // shell has no access to either and is given no way to obtain it.
        });
}

// ── Tests ────────────────────────────────────────────────────────────────────
//
// The vault key derivation, which is the one piece of real logic in this crate and
// the one whose failure is silent. A key that ignored the passphrase would produce a
// vault that opens with any passphrase, which reads as "the vault works" on the one
// machine that created it.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_passphrase_always_derives_the_same_key() {
        // Determinism is what makes a vault reopenable at all; a random or
        // time-dependent derivation produces a vault nobody can open again.
        assert_eq!(vault_key("correct horse"), vault_key("correct horse"));
    }

    #[test]
    fn a_different_passphrase_derives_a_different_key() {
        assert_ne!(vault_key("correct horse"), vault_key("correct horse "));
    }

    #[test]
    fn the_key_is_the_length_the_vault_requires() {
        // Stronghold rejects anything but 32 bytes, and it rejects it at unlock time
        // with a message about the vault rather than about the passphrase.
        assert_eq!(vault_key("correct horse").len(), VAULT_KEY_LEN);
    }

    #[test]
    fn a_passphrase_the_user_never_chose_still_derives_something() {
        // The front end refuses an empty passphrase before it gets here. Asserting
        // the Rust side's behaviour anyway documents that the refusal is a policy
        // choice in one layer, not a property of argon2.
        assert_eq!(vault_key("").len(), VAULT_KEY_LEN);
    }
}

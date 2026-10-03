// apps/frontend/native/src/lib/platform/stronghold_vault.ts
//
// The Tauri binding for `VaultPort`: a Stronghold snapshot under the app's data
// directory, opened with a passphrase the user types.
//
// Why Stronghold, and what "verified cross-platform" means here
// -----------------------------------------------------------
// It is a supported Tauri plugin with a Rust implementation behind all three
// desktop platforms and both mobile ones, and this file is the only place in the
// repository that names it. The *policy* around it — locked, wrong passphrase,
// expiry, revocation, environment switch — lives in `vault_session_store.ts` and
// is asserted against a fake port, so a change to the driver cannot quietly
// change what those rules mean.
//
// What this file deliberately does not do:
//
//   * **It does not store the passphrase.** `Stronghold.load(path, password)`
//     takes it, derives from it and keeps nothing on this side. The string is a
//     parameter; no field, no closure and no log holds it afterwards. The
//     passphrase is the *user's*, typed per unlock — this is the cross-platform
//     answer, and the reason the default session is memory-only is that a
//     persisted credential needs an unlock somebody chose.
//   * **It does not cache an unlocked snapshot across a sign-out.** `unlock` is
//     refused while already open, so there is one passphrase check per open
//     rather than a second path into the vault.
//   * **It does not fall back to a file.** No `localStorage`, no
//     `sessionStorage`, no JSON in the data directory. A vault that could not be
//     opened is a locked app, not a plaintext one.
//
// Two properties of the pinned plugin (2.4.0) are worth writing down because they
// change what "unlock" means:
//
//   1. `Stronghold.load` *creates* the snapshot when the file does not exist, for
//      any passphrase. So a wrong passphrase on a fresh install succeeds and
//      yields an empty vault, and a wrong passphrase on an existing install
//      fails. There is no way to tell those apart from the client alone, so the
//      UI says "unlock" and a user who has just installed sees it work.
//   2. Writes are not persisted until `save()`. Every mutation below saves, so a
//      "remember sign-in" that the app reports as stored is stored.

import { invoke } from '@tauri-apps/api/core';
import { type Client, type Store, Stronghold } from '@tauri-apps/plugin-stronghold';
import { redactSecret, type VaultPort } from './vault_session_store.ts';

/** One client inside the snapshot. The name is part of the on-disk layout. */
const CLIENT_NAME = 'starter-native-session';

export class VaultUnavailableError extends Error {
  override readonly name = 'VaultUnavailableError';
}

export interface StrongholdVaultOptions {
  /**
   * Resolves the snapshot path.
   *
   * Injected so a test does not need a data directory, and so the *default* can
   * be the one narrow application command (`vault_snapshot_path`) rather than the
   * `path` plugin: a front end that could name a path could aim the vault
   * anywhere, and the path plugin is a permission this template would otherwise
   * carry for one string.
   */
  readonly resolvePath?: () => Promise<string>;
}

/** Decode UTF-8 bytes the plugin returns. */
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/**
 * Stronghold as `VaultPort`.
 *
 * The store is handed one of these and never sees the plugin again, which is what
 * lets the store's tests run without a shell.
 */
export class StrongholdVault implements VaultPort {
  readonly #resolvePath: () => Promise<string>;
  #stronghold: Stronghold | null = null;
  #store: Store | null = null;

  constructor(options: StrongholdVaultOptions = {}) {
    this.#resolvePath = options.resolvePath ?? (() => invoke<string>('vault_snapshot_path'));
  }

  /**
   * Open the snapshot, or create it.
   *
   * A rejection here is a wrong passphrase on an existing snapshot, or a
   * snapshot that cannot be read at all. Both are reported the same way, with
   * the driver's own message redacted, because telling a user "wrong passphrase"
   * when the file is corrupt sends them to retype it forever.
   */
  async unlock(passphrase: string): Promise<void> {
    if (this.#stronghold !== null) {
      throw new VaultUnavailableError(
        'The session vault is already open in this process. Unlock is a per-start ' +
          'action, and a second one would be a second answer to the same question.',
      );
    }
    if (passphrase.length === 0) {
      throw new VaultUnavailableError('An empty passphrase cannot unlock the vault.');
    }

    try {
      const path = await this.#resolvePath();
      const stronghold = await Stronghold.load(path, passphrase);
      const client = await this.#clientFor(stronghold);
      this.#stronghold = stronghold;
      this.#store = client.getStore();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new VaultUnavailableError(
        redactSecret(
          `The session vault could not be opened (${detail}). That is a passphrase that ` +
            'does not match this vault, or a snapshot this build cannot read.',
        ),
      );
    }
  }

  /** The existing client, or a new one. A snapshot with no client is normal. */
  async #clientFor(stronghold: Stronghold): Promise<Client> {
    try {
      return await stronghold.loadClient(CLIENT_NAME);
    } catch {
      return stronghold.createClient(CLIENT_NAME);
    }
  }

  async isUnlocked(): Promise<boolean> {
    return this.#stronghold !== null;
  }

  async read(key: string): Promise<string | null> {
    const store = this.#require();
    const bytes = await store.get(key);
    return bytes === null ? null : decoder.decode(bytes);
  }

  async write(key: string, value: string): Promise<void> {
    const store = this.#require();
    await store.insert(key, Array.from(encoder.encode(value)));
    await this.#requireStronghold().save();
  }

  async remove(key: string): Promise<void> {
    const store = this.#require();
    await store.remove(key);
    await this.#requireStronghold().save();
  }

  /**
   * Close the snapshot, so the next unlock re-checks the passphrase.
   *
   * Called when the app signs out or locks, and deliberately not called on a
   * page navigation: an unlocked vault is a per-process decision, and dropping
   * it because a route changed would make "remember sign-in" unusable.
   */
  async lock(): Promise<void> {
    const stronghold = this.#stronghold;
    this.#stronghold = null;
    this.#store = null;
    await stronghold?.unload();
  }

  #require(): Store {
    if (this.#store === null) {
      throw new VaultUnavailableError('The session vault is locked.');
    }
    return this.#store;
  }

  #requireStronghold(): Stronghold {
    if (this.#stronghold === null) {
      throw new VaultUnavailableError('The session vault is locked.');
    }
    return this.#stronghold;
  }
}

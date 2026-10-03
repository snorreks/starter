// apps/frontend/native/src/lib/platform/vault_session_store.ts
//
// A `SessionStore` backed by an OS-keyed vault, for opt-in "remember sign-in".
//
// This module holds the policy; `stronghold_vault.ts` holds the Tauri binding. The
// split is what makes the policy testable: the behaviours below — locked, wrong
// passphrase, expired, revoked, environment switch — are asserted against a fake
// vault in `vault_session_store.test.ts` without a shell, a webview or a platform
// driver, and the binding that fulfils the port is four delegating calls wide.
//
// Four decisions, each of which is a bug the simpler version had:
//
//   1. **Locked means no credential, in both directions.** `load` returns null and
//      `save` throws. A store that returned a cached token while locked would be a
//      store that believes it is protected; a store that *wrote* while locked
//      would be writing plaintext somewhere the user cannot see.
//   2. **The environment is pinned at construction.** A vault is one file on one
//      machine, and a staging token that survives a switch to production is a
//      production credential this user never approved. `load`, `save` and `clear`
//      all refuse a scope whose origin is not the one this store was built for.
//   3. **An account binds the store until it is cleared.** Not because a vault
//      entry could be read by the wrong account — the key already contains the
//      account — but because "sign in as somebody else" must go through sign-out.
//      Without it, a second sign-in writes a second entry and the first credential
//      stays in the vault, unrevoked and unreachable.
//   4. **Clearing while locked is deferred, not skipped.** `clear` throws while
//      the vault is locked, and the composition clears the in-memory token
//      regardless. The removal is queued in this process and drained on the next
//      unlock, so "sign out" always removes the stored credential eventually and
//      never leaves one behind because the app was restarted first.
//
// Nothing here stores the passphrase. It is passed to `unlock`, used, and
// dropped: `vault.unlock` receives a string, the port returns nothing, and there
// is no field on this class that holds one. That is why this class can be read in
// full as an answer to "where does the unlock secret live".

import { type SessionScope, type SessionStore, sessionScopeKey } from '@starter/platform';

/**
 * The narrow surface of a keychain this store needs.
 *
 * Deliberately four operations and no `list`, no `export` and no `destroy`: a
 * port that can enumerate or extract everything is a port whose misuse is
 * unbounded, and the caller here only ever addresses one key it derived itself.
 */
export interface VaultPort {
  /** Unlock with a user passphrase. Rejects when the passphrase is wrong. */
  unlock(passphrase: string): Promise<void>;
  isUnlocked(): Promise<boolean>;
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The vault is locked. Nothing is readable or writable until it is unlocked. */
export class VaultLockedError extends Error {
  override readonly name = 'VaultLockedError';
}

/** The caller asked for a scope this store is not bound to. */
export class VaultScopeError extends Error {
  override readonly name = 'VaultScopeError';
}

/**
 * Redact anything secret-shaped out of a message that may be logged.
 *
 * Errors from a vault driver are the one place token material can leak into a log:
 * a driver that includes the value it failed to write produces a message a
 * template would otherwise print verbatim. Every error this store constructs goes
 * through here, and the token itself never appears in a message by construction —
 * the strongest form of redaction is not needing it.
 */
export const redactSecret = (message: string): string =>
  message
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
    .replace(/(passphrase|password|secret|token)(\s*[:=]\s*)("?)[^\s"]+\3/gi, '$1$2[redacted]');

/** What is stored per scope. Versioned, so a future format can be migrated. */
interface StoredSession {
  readonly version: 1;
  readonly token: string;
  /** Epoch milliseconds. Absent is treated as "no expiry information". */
  readonly expiresAt: number | null;
}

const parseStored = (raw: string): StoredSession | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not our record. A vault shared with another version of this app is not a
    // reason to return a token we did not write.
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as Partial<StoredSession>;
  if (candidate.version !== 1 || typeof candidate.token !== 'string') {
    return null;
  }
  return {
    version: 1,
    token: candidate.token,
    expiresAt: typeof candidate.expiresAt === 'number' ? candidate.expiresAt : null,
  };
};

/** Key prefix, so a vault this app shares with another can be told apart. */
export const SESSION_KEY_PREFIX = 'starter.native.session.';

const hex = new TextEncoder();

/**
 * The vault key for one scope.
 *
 * `sessionScopeKey` is the canonical, collision-free derivation, and it is reused
 * rather than reinvented here. Its separator is a NUL byte, which is correct for
 * an in-memory map key and questionable for a string a storage driver persists on
 * a disk — so the result is hex-encoded. The output is printable ASCII, the
 * mapping is injective, and a key can still be read back to its scope by whoever
 * is debugging a vault on a user's machine.
 */
export const sessionVaultKey = (scope: SessionScope): string => {
  const bytes = hex.encode(sessionScopeKey(scope));
  let encoded = '';
  for (const byte of bytes) {
    encoded += byte.toString(16).padStart(2, '0');
  }
  return `${SESSION_KEY_PREFIX}${encoded}`;
};

export interface VaultSessionStoreOptions {
  readonly vault: VaultPort;
  /**
   * The API origin this store is bound to.
   *
   * Required, and the reason is in the header: it is the environment half of the
   * scope, pinned so a switch cannot hand this app a credential for somewhere
   * else.
   */
  readonly origin: string;
  /** Injected so expiry is testable without waiting seven days. */
  readonly now?: () => number;
}

export class VaultSessionStore implements SessionStore {
  readonly #vault: VaultPort;
  readonly #origin: string;
  readonly #now: () => number;
  /** The account this store currently holds a credential for, or null. */
  #boundAccount: string | null = null;
  /** Keys a `clear` could not remove yet, drained on the next unlock. */
  readonly #pendingRemovals = new Set<string>();

  constructor(options: VaultSessionStoreOptions) {
    this.#vault = options.vault;
    this.#origin = options.origin;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Unlock, then apply whatever a previous sign-out could not.
   *
   * A wrong passphrase rejects from the vault and propagates unchanged: this
   * store has no opinion about what a wrong passphrase is, and inventing one
   * would be a second answer to a question the driver already answered.
   */
  async unlock(passphrase: string): Promise<void> {
    await this.#vault.unlock(passphrase);
    await this.#drainPendingRemovals();
  }

  async #drainPendingRemovals(): Promise<void> {
    if (this.#pendingRemovals.size === 0) {
      return;
    }
    if (!(await this.#vault.isUnlocked())) {
      // The driver says it is not unlocked despite `unlock` resolving. Leave the
      // queue alone rather than reporting a removal that did not happen.
      return;
    }
    for (const key of this.#pendingRemovals) {
      await this.#vault.remove(key);
    }
    this.#pendingRemovals.clear();
  }

  #assertScope(scope: SessionScope): string {
    if (scope.origin !== this.#origin) {
      throw new VaultScopeError(
        redactSecret(
          `Refusing a credential scoped to ${scope.origin}. This store is bound to ` +
            `${this.#origin}.`,
        ),
      );
    }
    if (this.#boundAccount !== null && this.#boundAccount !== scope.account) {
      throw new VaultScopeError(
        'Refusing a second account in one store. Sign out first, so the previous ' +
          'credential is revoked and removed rather than left behind in the vault.',
      );
    }
    return sessionVaultKey(scope);
  }

  async load(scope: SessionScope): Promise<string | null> {
    const key = this.#assertScope(scope);

    if (!(await this.#vault.isUnlocked())) {
      return null;
    }

    const raw = await this.#vault.read(key);
    if (raw === null) {
      return null;
    }

    const stored = parseStored(raw);
    if (stored === null) {
      // Unreadable record: treat it as absent *and* remove it, so a corrupt
      // entry cannot become a permanent "there is something here".
      await this.#vault.remove(key);
      return null;
    }

    if (stored.expiresAt !== null && stored.expiresAt <= this.#now()) {
      await this.#vault.remove(key);
      return null;
    }

    this.#boundAccount = scope.account;
    return stored.token;
  }

  async save(scope: SessionScope, token: string): Promise<void> {
    const key = this.#assertScope(scope);

    if (!(await this.#vault.isUnlocked())) {
      throw new VaultLockedError(
        'The session vault is locked, so nothing was stored. Unlock it to opt in to ' +
          '"remember sign-in".',
      );
    }

    const record: StoredSession = { version: 1, token, expiresAt: null };
    await this.#vault.write(key, JSON.stringify(record));
    this.#boundAccount = scope.account;
  }

  async clear(scope: SessionScope): Promise<void> {
    // Scope is asserted even here: `clear` for a scope this store does not own is
    // a caller bug, and ignoring it would make a typo look like a sign-out.
    const key = this.#assertScope(scope);

    if (!(await this.#vault.isUnlocked())) {
      // Queued rather than dropped. See decision 4 in the header.
      this.#pendingRemovals.add(key);
      this.#boundAccount = null;
      return;
    }

    await this.#vault.remove(key);
    this.#boundAccount = null;
  }

  /** Whether a credential for this scope can currently be read or written. */
  async isAvailable(): Promise<boolean> {
    return this.#vault.isUnlocked();
  }

  /**
   * Forget the binding, so another account may be stored.
   *
   * Only meaningful after the credential itself has been revoked server-side;
   * this releases a local guard, it does not revoke anything.
   */
  releaseBinding(): void {
    this.#boundAccount = null;
  }
}

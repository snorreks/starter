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

import {
  ReauthenticationRequiredError,
  type SessionCredential,
  type SessionScope,
  type SessionStore,
  sessionScopeKey,
} from '@starter/platform';

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

export interface LegacySessionScope {
  readonly origin: string;
  readonly account: string;
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
export const sessionVaultKey = (scope: SessionScope | LegacySessionScope): string => {
  const key =
    'environment' in scope ? sessionScopeKey(scope) : `${scope.origin}\u0000${scope.account}`;
  const bytes = hex.encode(key);
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

const legacySessionVaultKey = (scope: LegacySessionScope): string => sessionVaultKey(scope);

export class VaultSessionStore {
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

  #assertScope(scope: LegacySessionScope): string {
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
    return legacySessionVaultKey(scope);
  }

  // Separate namespace from session records, with a fixed key per origin.
  #accountKey(): string {
    return `starter.native.last-account.${encodeURIComponent(this.#origin)}`;
  }

  async rememberStoredAccount(account: string): Promise<void> {
    this.#assertScope({ origin: this.#origin, account });
    if (!(await this.#vault.isUnlocked())) {
      throw new VaultLockedError('Unlock the session vault before remembering an account.');
    }
    await this.#vault.write(this.#accountKey(), account);
  }

  async knownAccounts(): Promise<string[]> {
    if (!(await this.#vault.isUnlocked())) {
      return [];
    }
    const account = await this.#vault.read(this.#accountKey());
    return account === null ? [] : [account];
  }

  async load(scope: LegacySessionScope): Promise<string | null> {
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
      await this.clear(scope);
      return null;
    }

    if (stored.expiresAt !== null && stored.expiresAt <= this.#now()) {
      await this.clear(scope);
      return null;
    }

    this.#boundAccount = scope.account;
    return stored.token;
  }

  async save(scope: LegacySessionScope, token: string): Promise<void> {
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
    await this.rememberStoredAccount(scope.account);
  }

  async clear(scope: LegacySessionScope): Promise<void> {
    // Scope is asserted even here: `clear` for a scope this store does not own is
    // a caller bug, and ignoring it would make a typo look like a sign-out.
    const key = this.#assertScope(scope);

    if (!(await this.#vault.isUnlocked())) {
      // Queued rather than dropped. See decision 4 in the header.
      this.#pendingRemovals.add(key);
      this.#pendingRemovals.add(this.#accountKey());
      this.#boundAccount = null;
      return;
    }

    await this.#vault.remove(key);
    await this.#vault.remove(this.#accountKey());
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

const legacyKey = (scope: SessionScope): string => {
  const legacyScope = `${scope.apiOrigin}\u0000${scope.accountId}`;
  return `${SESSION_KEY_PREFIX}${[...new TextEncoder().encode(legacyScope)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

/** Versioned Supabase credentials in Stronghold, isolated from legacy bearer records. */
export class CredentialVaultSessionStore implements SessionStore {
  readonly #vault: VaultPort;
  readonly #scope: Omit<SessionScope, 'accountId'>;
  readonly #now: () => number;
  #boundAccount: string | null = null;

  constructor(options: {
    readonly vault: VaultPort;
    readonly scope: Omit<SessionScope, 'accountId'>;
    readonly now?: () => number;
  }) {
    this.#vault = options.vault;
    this.#scope = options.scope;
    this.#now = options.now ?? Date.now;
  }

  unlock(passphrase: string): Promise<void> {
    return this.#vault.unlock(passphrase);
  }

  #key(scope: SessionScope): string {
    if (
      scope.environment !== this.#scope.environment ||
      scope.supabaseProjectRef !== this.#scope.supabaseProjectRef ||
      scope.apiOrigin !== this.#scope.apiOrigin
    ) {
      throw new VaultScopeError(
        'Refusing a credential for a different environment, Supabase project, or API origin.',
      );
    }
    if (this.#boundAccount !== null && this.#boundAccount !== scope.accountId) {
      throw new VaultScopeError('Sign out before binding another account to this secure store.');
    }
    return sessionVaultKey(scope);
  }

  #accountsKey(): string {
    return `starter.native.supabase.accounts.${encodeURIComponent(JSON.stringify(this.#scope))}`;
  }

  async knownAccounts(scope: Omit<SessionScope, 'accountId'>): Promise<string[]> {
    this.#assertBaseScope(scope);
    if (!(await this.#vault.isUnlocked())) {
      return [];
    }
    const current = await this.#vault.read(this.#accountsKey());
    if (current !== null) {
      try {
        const parsed: unknown = JSON.parse(current);
        if (Array.isArray(parsed) && parsed.every((account) => typeof account === 'string')) {
          return parsed;
        }
      } catch {
        /* Corrupt index is removed below. */
      }
      await this.#vault.remove(this.#accountsKey());
      throw new ReauthenticationRequiredError(
        'The saved account index is incompatible. Sign in again.',
      );
    }
    // Older versions kept one origin-scoped account index and a token-only record.
    const legacyAccount = await this.#vault.read(
      `starter.native.last-account.${encodeURIComponent(scope.apiOrigin)}`,
    );
    return legacyAccount === null ? [] : [legacyAccount];
  }

  async load(scope: SessionScope): Promise<SessionCredential | null> {
    const key = this.#key(scope);
    if (!(await this.#vault.isUnlocked())) {
      return null;
    }
    const raw = await this.#vault.read(key);
    if (raw !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      if (!isCredential(parsed) || !matchesScope(parsed, scope)) {
        await this.#vault.remove(key);
        throw new ReauthenticationRequiredError(
          'The saved credential format is incompatible. Sign in again.',
        );
      }
      if (parsed.expiresAt <= this.#now()) {
        this.#boundAccount = parsed.accountId;
        return parsed;
      }
      this.#boundAccount = parsed.accountId;
      return parsed;
    }
    const previous = await this.#vault.read(legacyKey(scope));
    if (previous !== null) {
      await this.#vault.remove(legacyKey(scope));
      await this.#vault.remove(
        `starter.native.last-account.${encodeURIComponent(scope.apiOrigin)}`,
      );
      this.#boundAccount = null;
      throw new ReauthenticationRequiredError(
        'A legacy bearer credential cannot be used as a Supabase refresh session. Sign in again.',
      );
    }
    return null;
  }

  async save(scope: SessionScope, credential: SessionCredential): Promise<void> {
    const key = this.#key(scope);
    if (!isCredential(credential) || !matchesScope(credential, scope)) {
      throw new VaultScopeError('Refusing a malformed or differently scoped Supabase credential.');
    }
    if (!(await this.#vault.isUnlocked())) {
      throw new VaultLockedError('Unlock the secure store before opting in to remember sign-in.');
    }
    await this.#vault.write(key, JSON.stringify(credential));
    await this.#vault.write(this.#accountsKey(), JSON.stringify([credential.accountId]));
    this.#boundAccount = credential.accountId;
  }

  async clear(scope: SessionScope): Promise<void> {
    const key = this.#key(scope);
    if (!(await this.#vault.isUnlocked())) {
      throw new VaultLockedError('Unlock the secure store to remove the persisted session.');
    }
    await this.#vault.remove(key);
    await this.#vault.remove(this.#accountsKey());
    this.#boundAccount = null;
  }

  async isAvailable(): Promise<boolean> {
    return this.#vault.isUnlocked();
  }

  releaseBinding(): void {
    this.#boundAccount = null;
  }

  #assertBaseScope(scope: Omit<SessionScope, 'accountId'>): void {
    if (
      scope.environment !== this.#scope.environment ||
      scope.supabaseProjectRef !== this.#scope.supabaseProjectRef ||
      scope.apiOrigin !== this.#scope.apiOrigin
    ) {
      throw new VaultScopeError(
        'Refusing a different environment, Supabase project, or API origin.',
      );
    }
  }
}

const isCredential = (value: unknown): value is SessionCredential => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const item = value as Partial<SessionCredential>;
  return (
    item.version === 1 &&
    typeof item.accessToken === 'string' &&
    item.accessToken.length > 0 &&
    typeof item.refreshToken === 'string' &&
    item.refreshToken.length > 0 &&
    typeof item.expiresAt === 'number' &&
    typeof item.accountId === 'string' &&
    typeof item.supabaseProjectRef === 'string' &&
    typeof item.apiOrigin === 'string'
  );
};

const matchesScope = (credential: SessionCredential, scope: SessionScope): boolean =>
  credential.supabaseProjectRef === scope.supabaseProjectRef &&
  credential.apiOrigin === scope.apiOrigin &&
  credential.accountId === scope.accountId;

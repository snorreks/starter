// apps/frontend/native/src/lib/platform/vault_session_store.test.ts
//
// The vault behaviours the acceptance criteria name, asserted against a fake port.
//
// A real Stronghold instance needs the Tauri shell, a loaded `stronghold-lib` and
// a passphrase, so a test that drove one would either be an integration test in
// this file or a test that mocks the very boundary it claims to check. The port
// is four methods wide, so the fake is exact, and every behaviour asserted here —
// locked, wrong passphrase, expired, revoked, environment switch — is decided by
// this class rather than by the driver.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { SessionScope } from '@starter/platform';
import {
  redactSecret,
  sessionVaultKey,
  VaultLockedError,
  type VaultPort,
  VaultScopeError,
  VaultSessionStore,
} from './vault_session_store.ts';

const PRODUCTION: SessionScope = { origin: 'https://api.example.test', account: 'user_a' };
const OTHER_USER: SessionScope = { origin: 'https://api.example.test', account: 'user_b' };
const STAGING: SessionScope = { origin: 'https://staging.example.test', account: 'user_a' };
const TOKEN = 'session-token-value-that-must-never-appear-in-a-message';

/** A vault that behaves the way the Stronghold adapter does, including its refusals. */
class FakeVault implements VaultPort {
  readonly entries = new Map<string, string>();
  unlocked = false;
  /** The passphrase the fake believes is correct. */
  passphrase = 'correct horse';
  /** Every key `remove` was asked to delete. */
  readonly removed: string[] = [];

  async unlock(passphrase: string): Promise<void> {
    if (passphrase !== this.passphrase) {
      throw new Error('Invalid client password');
    }
    this.unlocked = true;
  }

  async isUnlocked(): Promise<boolean> {
    return this.unlocked;
  }

  async read(key: string): Promise<string | null> {
    if (!this.unlocked) {
      throw new Error('the client is locked');
    }
    return this.entries.get(key) ?? null;
  }

  async write(key: string, value: string): Promise<void> {
    if (!this.unlocked) {
      throw new Error('the client is locked');
    }
    this.entries.set(key, value);
  }

  async remove(key: string): Promise<void> {
    if (!this.unlocked) {
      throw new Error('the client is locked');
    }
    this.removed.push(key);
    this.entries.delete(key);
  }
}

let vault: FakeVault;
let store: VaultSessionStore;
let clock: number;

beforeEach(() => {
  vault = new FakeVault();
  clock = 1_700_000_000_000;
  store = new VaultSessionStore({
    vault,
    origin: PRODUCTION.origin,
    now: () => clock,
  });
});

describe('a store nobody has unlocked', () => {
  test('reads nothing rather than reaching into the vault', async () => {
    // Locked must be an answer, not an exception a screen has to catch.
    expect(await store.load(PRODUCTION)).toBeNull();
  });

  test('refuses to store anything', async () => {
    await expect(store.save(PRODUCTION, TOKEN)).rejects.toBeInstanceOf(VaultLockedError);
    expect(vault.entries.size).toBe(0);
  });
});

describe('an unlocked store', () => {
  beforeEach(async () => {
    await store.unlock(vault.passphrase);
  });

  test('stores a credential and returns it for the same scope', async () => {
    await store.save(PRODUCTION, TOKEN);
    expect(await store.load(PRODUCTION)).toBe(TOKEN);
  });

  test('a wrong passphrase does not unlock, and stores nothing', async () => {
    const fresh = new FakeVault();
    const freshStore = new VaultSessionStore({ vault: fresh, origin: PRODUCTION.origin });

    await expect(freshStore.unlock('not it')).rejects.toThrow(/password/i);
    expect(await freshStore.isAvailable()).toBe(false);
    await expect(freshStore.save(PRODUCTION, TOKEN)).rejects.toBeInstanceOf(VaultLockedError);
    expect(fresh.entries.size).toBe(0);
  });

  test('a scope for another environment is refused in all three operations', async () => {
    // The vault is one file. A staging token that survived a switch to production
    // is a production credential this user never approved.
    await expect(store.load(STAGING)).rejects.toBeInstanceOf(VaultScopeError);
    await expect(store.save(STAGING, TOKEN)).rejects.toBeInstanceOf(VaultScopeError);
    await expect(store.clear(STAGING)).rejects.toBeInstanceOf(VaultScopeError);
    expect(vault.entries.size).toBe(0);
  });

  test('signing in as a second account requires signing out first', async () => {
    await store.save(PRODUCTION, TOKEN);
    await expect(store.save(OTHER_USER, 'another-token')).rejects.toBeInstanceOf(VaultScopeError);

    await store.clear(PRODUCTION);
    await store.save(OTHER_USER, 'another-token');
    expect(await store.load(OTHER_USER)).toBe('another-token');
    // The first credential is gone rather than left behind unrevoked. Reading it
    // back is refused outright while another account is bound: the store will not
    // answer a question about one account from inside another's session.
    await expect(store.load(PRODUCTION)).rejects.toBeInstanceOf(VaultScopeError);
  });

  test('an expired credential is removed, not returned', async () => {
    // Written by hand so the record carries an expiry: this store does not set one
    // (it does not know the session's lifetime — the server does), and a store
    // that invents one would silently keep sessions shorter or longer than the
    // server intends.
    const key = sessionVaultKey(PRODUCTION);
    vault.entries.set(key, JSON.stringify({ version: 1, token: TOKEN, expiresAt: clock + 1_000 }));

    clock += 1_000;
    expect(await store.load(PRODUCTION)).toBeNull();
    expect(vault.entries.has(key)).toBe(false);
  });

  test('a record this version did not write is treated as absent and removed', async () => {
    const key = sessionVaultKey(PRODUCTION);
    vault.entries.set(key, JSON.stringify({ version: 99, token: TOKEN, expiresAt: null }));

    expect(await store.load(PRODUCTION)).toBeNull();
    expect(vault.entries.has(key)).toBe(false);
  });

  test('a corrupt entry is treated as absent and removed', async () => {
    const key = sessionVaultKey(PRODUCTION);
    vault.entries.set(key, 'not json at all');

    expect(await store.load(PRODUCTION)).toBeNull();
    expect(vault.removed).toContain(key);
  });
});

describe('signing out', () => {
  test('removes the credential', async () => {
    await store.unlock(vault.passphrase);
    await store.save(PRODUCTION, TOKEN);
    await store.clear(PRODUCTION);

    expect(vault.entries.size).toBe(0);
    expect(await store.load(PRODUCTION)).toBeNull();
  });

  test('while locked, the removal is deferred and applied on the next unlock', async () => {
    // Sign-out must always happen, and a locked vault is a normal state after a
    // restart. Dropping the removal would leave a live credential on disk.
    await store.unlock(vault.passphrase);
    await store.save(PRODUCTION, TOKEN);

    const restarted = new VaultSessionStore({ vault, origin: PRODUCTION.origin });
    vault.unlocked = false; // the process restarted: the vault is locked again

    await restarted.clear(PRODUCTION);
    expect(vault.entries.size).toBe(1);

    await restarted.unlock(vault.passphrase);
    expect(vault.entries.size).toBe(0);
  });
});

describe('messages', () => {
  test('never carry a token, a passphrase or a long opaque value', () => {
    expect(redactSecret(`failed for ${TOKEN}`)).not.toContain(TOKEN);
    expect(redactSecret('token=abc123secret')).toBe('token=[redacted]');
    expect(redactSecret('passphrase: hunter2')).toBe('passphrase: [redacted]');
    // Short values are not redacted — this is a log, not a vault, and a message
    // about a port or a status code must stay readable.
    expect(redactSecret('locked at 127.0.0.1:5173')).toBe('locked at 127.0.0.1:5173');
  });

  test('a scope error names the origins and no secret', async () => {
    const fresh = new VaultSessionStore({ vault, origin: PRODUCTION.origin });
    await expect(fresh.load(STAGING)).rejects.toThrow(/staging\.example\.test/);
    await fresh.unlock(vault.passphrase);
    const error = await fresh.save(STAGING, TOKEN).catch((caught: unknown) => caught);
    expect(String(error)).not.toContain(TOKEN);
  });
});

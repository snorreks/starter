// packages/frontend/platform/src/session_store.test.ts
//
// The scope is the feature. These cases exist because every one of them is a
// credential reaching the wrong person, and none of them would fail in a store
// keyed by a single constant.

import { describe, expect, test } from 'bun:test';
import { MemorySessionStore, type SessionScope, sessionScopeKey } from './session_store.ts';

const scope = (origin: string, account: string): SessionScope => ({ origin, account });

const STAGING = scope('https://staging.example.test', 'user_1');
const PRODUCTION = scope('https://example.test', 'user_1');
const OTHER_ACCOUNT = scope('https://staging.example.test', 'user_2');

describe('a stored credential is scoped by deployment and account', () => {
  test('saving under one scope does not satisfy a load for another', async () => {
    const store = new MemorySessionStore();
    await store.save(STAGING, 'staging-token');

    // The failure this prevents: a token issued by staging being sent to
    // production because both are "the current token".
    expect(await store.load(PRODUCTION)).toBeNull();
  });

  test('one account cannot read another account credential', async () => {
    const store = new MemorySessionStore();
    await store.save(STAGING, 'user_1-token');

    expect(await store.load(OTHER_ACCOUNT)).toBeNull();
  });

  test('clearing one scope leaves the other scope signed in', async () => {
    // Signing out of the staging deployment must not sign the user out of
    // production, and the reverse is the same bug.
    const store = new MemorySessionStore();
    await store.save(STAGING, 'staging-token');
    await store.save(PRODUCTION, 'production-token');

    await store.clear(STAGING);

    expect(await store.load(STAGING)).toBeNull();
    expect(await store.load(PRODUCTION)).toBe('production-token');
  });

  test('a save replaces the previous value for the same scope', async () => {
    const store = new MemorySessionStore();
    await store.save(STAGING, 'first');
    await store.save(STAGING, 'second');

    expect(await store.load(STAGING)).toBe('second');
  });

  test('clearing a scope that holds nothing is not an error', async () => {
    // Sign-out has to be safe to call twice: a second clear that threw would leave
    // a user stuck on a screen whose only button is "sign out".
    const store = new MemorySessionStore();
    await expect(store.clear(PRODUCTION)).resolves.toBeUndefined();
  });

  test('loading before anything was saved answers null rather than throwing', async () => {
    expect(await new MemorySessionStore().load(STAGING)).toBeNull();
  });
});

describe('the derived key cannot collide', () => {
  test('an account name that looks like part of an origin is a different key', async () => {
    // A naive `origin + account` join makes these two identical, which would let
    // account `a` on one host load account `a` on another.
    expect(sessionScopeKey(scope('https://a.example.test', 'b'))).not.toBe(
      sessionScopeKey(scope('https://a.example.testb', '')),
    );
  });

  test('the key names the deployment and the account', () => {
    expect(sessionScopeKey(STAGING)).toContain('https://staging.example.test');
    expect(sessionScopeKey(STAGING)).toContain('user_1');
  });
});

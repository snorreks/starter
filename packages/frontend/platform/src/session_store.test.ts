import { describe, expect, test } from 'bun:test';
import {
  MemorySessionStore,
  type SessionCredential,
  type SessionScope,
  sessionScopeKey,
} from './session_store.ts';

const scope = (
  environment: string,
  project: string,
  origin: string,
  account: string,
): SessionScope => ({
  environment,
  supabaseProjectRef: project,
  apiOrigin: origin,
  accountId: account,
});
const credential = (value: SessionScope): SessionCredential => ({
  version: 1,
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  expiresAt: 1_900_000_000_000,
  accountId: value.accountId,
  supabaseProjectRef: value.supabaseProjectRef,
  apiOrigin: value.apiOrigin,
});

describe('versioned credentials are isolated across all deployment identity dimensions', () => {
  const origin = scope('staging', 'project-a', 'https://staging.example.test', 'user-a');

  test.each([
    ['environment', scope('production', 'project-a', 'https://staging.example.test', 'user-a')],
    ['project', scope('staging', 'project-b', 'https://staging.example.test', 'user-a')],
    ['API origin', scope('staging', 'project-a', 'https://other.example.test', 'user-a')],
    ['account', scope('staging', 'project-a', 'https://staging.example.test', 'user-b')],
  ])('does not load a credential from another %s', async (_dimension, other) => {
    const store = new MemorySessionStore();
    await store.save(origin, credential(origin));
    expect(await store.load(other)).toBeNull();
  });

  test('stores only the versioned credential and clears only that scope', async () => {
    const store = new MemorySessionStore();
    const saved = credential(origin);
    await store.save(origin, saved);
    expect(await store.load(origin)).toEqual(saved);
    await store.clear(origin);
    expect(await store.load(origin)).toBeNull();
  });

  test('refuses a record whose credential scope disagrees with the key', async () => {
    const store = new MemorySessionStore();
    await expect(
      store.save(origin, credential(scope('production', 'p', 'https://prod.test', 'u'))),
    ).rejects.toThrow('Credential scope does not match');
  });

  test('scope keys include every dimension without delimiter collisions', () => {
    expect(sessionScopeKey(origin)).not.toBe(
      sessionScopeKey(
        scope('staging', 'project-a', 'https://staging.example.test', 'user-a\u0000x'),
      ),
    );
  });
});

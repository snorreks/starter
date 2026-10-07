import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { SupabaseAuthError } from '#lib/platform/supabase_auth.ts';

mock.module('#lib/runtime/config.ts', () => ({
  nativeConfig: {
    authProfile: 'supabase',
    apiOrigin: 'https://api.example.test',
    dev: false,
    environment: 'test',
    supabaseProjectRef: 'project',
    supabaseUrl: 'https://project.example.test',
    supabaseAnonKey: 'public-fixture-key',
    nativeCallback: 'com.example.starter://auth/callback',
    webCallback: 'https://api.example.test/auth/callback',
    allowedCallbacks: [
      'com.example.starter://auth/callback',
      'https://api.example.test/auth/callback',
    ],
  },
}));
const { refreshNativeSession, sessionState, supabaseNativeAuth } = await import('./session.ts');
if (supabaseNativeAuth === null) {
  throw new Error('Supabase test configuration missing');
}
const auth = supabaseNativeAuth;
afterEach(() => {
  mock.restore();
  Reflect.deleteProperty(auth, 'accessToken');
  Reflect.deleteProperty(auth, 'user');
  sessionState.set(null);
});

test('restored sessions refresh before identity resolution', async () => {
  const calls: string[] = [];
  spyOn(auth, 'restore').mockResolvedValue({ id: 'user-1', email: null });
  spyOn(auth, 'ensureFreshAccessToken').mockImplementation(async () => {
    calls.push('fresh');
  });
  spyOn(auth, 'getCurrentUser').mockImplementation(async () => {
    calls.push('identity');
    return { id: 'user-1', email: 'user@example.test' };
  });
  await refreshNativeSession();
  expect(calls).toEqual(['fresh', 'identity']);
  expect(sessionState.user?.email).toBe('user@example.test');
});

for (const status of [401, 403, 500]) {
  test(`identity rejection ${status} clears credentials only when rejected by Auth`, async () => {
    spyOn(auth, 'restore').mockResolvedValue({ id: 'user-1', email: null });
    spyOn(auth, 'ensureFreshAccessToken').mockResolvedValue();
    spyOn(auth, 'getCurrentUser').mockRejectedValue(
      new SupabaseAuthError('Rejected', status, '/auth/v1/user'),
    );
    const signOut = spyOn(auth, 'signOut').mockResolvedValue();
    await refreshNativeSession();
    expect(sessionState.user).toBeNull();
    expect(signOut).toHaveBeenCalledTimes(status === 500 ? 0 : 1);
  });
}

test('a null identity keeps the existing signed-out behavior', async () => {
  spyOn(auth, 'restore').mockResolvedValue({ id: 'user-1', email: null });
  spyOn(auth, 'ensureFreshAccessToken').mockResolvedValue();
  spyOn(auth, 'getCurrentUser').mockResolvedValue(null);
  const signOut = spyOn(auth, 'signOut').mockResolvedValue();
  await refreshNativeSession();
  expect(sessionState.user).toBeNull();
  expect(signOut).not.toHaveBeenCalled();
});

test('an empty store never requests refresh or identity', async () => {
  spyOn(auth, 'restore').mockResolvedValue(null);
  const fresh = spyOn(auth, 'ensureFreshAccessToken');
  const identity = spyOn(auth, 'getCurrentUser');
  await refreshNativeSession();
  expect(fresh).not.toHaveBeenCalled();
  expect(identity).not.toHaveBeenCalled();
});

test('an in-memory session refreshes before identity without reopening the store', async () => {
  const calls: string[] = [];
  Object.defineProperties(auth, {
    accessToken: { value: 'existing-token', configurable: true },
    user: { value: { id: 'user-1', email: null }, configurable: true },
  });
  const restore = spyOn(auth, 'restore');
  spyOn(auth, 'ensureFreshAccessToken').mockImplementation(async () => {
    calls.push('fresh');
  });
  spyOn(auth, 'getCurrentUser').mockImplementation(async () => {
    calls.push('identity');
    return { id: 'user-1', email: 'user@example.test' };
  });
  await refreshNativeSession();
  expect(restore).not.toHaveBeenCalled();
  expect(calls).toEqual(['fresh', 'identity']);
});

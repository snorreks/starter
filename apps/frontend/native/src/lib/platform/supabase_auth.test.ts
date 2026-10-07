import { describe, expect, test } from 'bun:test';
import {
  ReauthenticationRequiredError,
  type SessionCredential,
  type SessionScope,
  type SessionStore,
} from '@starter/platform';
import { InvalidAuthCallbackError, SupabaseNativeAuth } from './supabase_auth.ts';

const config = {
  environment: 'test',
  supabaseProjectRef: 'local-project',
  apiOrigin: 'http://127.0.0.1:8787',
  supabaseUrl: 'http://127.0.0.1:54321',
  anonKey: 'public-test-key',
  nativeCallback: 'com.example.starter://auth/callback',
  webCallback: 'http://127.0.0.1:5173/auth/callback',
  allowedCallbacks: ['com.example.starter://auth/callback', 'http://127.0.0.1:5173/auth/callback'],
} as const;

class Store implements SessionStore {
  value: SessionCredential | null = null;
  savedScope: SessionScope | null = null;
  saves = 0;
  async knownAccounts(scope: Omit<SessionScope, 'accountId'>) {
    return this.value !== null && this.savedScope !== null && sameBase(this.savedScope, scope)
      ? [this.value.accountId]
      : [];
  }
  async load(scope: SessionScope) {
    return this.value !== null && this.savedScope !== null && sameScope(this.savedScope, scope)
      ? this.value
      : null;
  }
  async save(scope: SessionScope, credential: SessionCredential) {
    if (
      scope.accountId !== credential.accountId ||
      scope.supabaseProjectRef !== credential.supabaseProjectRef ||
      scope.apiOrigin !== credential.apiOrigin
    ) {
      throw new Error('wrong scope');
    }
    this.saves += 1;
    this.savedScope = scope;
    this.value = credential;
  }
  async clear(scope: SessionScope) {
    if (this.value !== null && this.savedScope !== null && sameScope(this.savedScope, scope)) {
      this.value = null;
      this.savedScope = null;
    }
  }
}
const sameBase = (
  left: Omit<SessionScope, 'accountId'>,
  right: Omit<SessionScope, 'accountId'>,
): boolean =>
  left.environment === right.environment &&
  left.supabaseProjectRef === right.supabaseProjectRef &&
  left.apiOrigin === right.apiOrigin;
const sameScope = (left: SessionScope, right: SessionScope): boolean =>
  sameBase(left, right) && left.accountId === right.accountId;
const tokenResponse = (accountId = 'user-1', access = 'access-1', refresh = 'refresh-1') => ({
  access_token: access,
  refresh_token: refresh,
  expires_in: 3600,
  user: { id: accountId, email: 'user@example.test' },
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
const callback = (opened: string): string => {
  const authUrl = new URL(opened);
  const redirectTo = authUrl.searchParams.get('redirect_to');
  if (redirectTo === null) {
    throw new Error('OAuth authorization URL has no redirect target.');
  }
  const redirect = new URL(redirectTo);
  redirect.searchParams.set('code', 'auth-code');
  return redirect.toString();
};

describe('native Supabase PKCE', () => {
  test('refuses project URLs that are not exact configured origins', () => {
    expect(
      () =>
        new SupabaseNativeAuth({
          config: { ...config, supabaseUrl: `${config.supabaseUrl}/` },
          store: new Store(),
          openBrowser: async () => {},
        }),
    ).toThrow(/HTTPS origin|loopback HTTP origin/);
  });

  test('sends only a verifier challenge to the browser and consumes one callback', async () => {
    const store = new Store();
    let opened = '';
    let requestUrl = '';
    let body = '';
    const auth = new SupabaseNativeAuth({
      config,
      store,
      openBrowser: async (url) => {
        opened = url;
      },
      now: () => 1000,
      fetch: async (input, init) => {
        requestUrl = String(input);
        body = String(init?.body ?? '');
        return Response.json(tokenResponse());
      },
    });
    auth.setPersistenceEnabled(true);
    await auth.beginOAuth('google');
    const authorize = new URL(opened);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('s256');
    expect(authorize.searchParams.has('code_verifier')).toBe(false);
    const redirectTo = authorize.searchParams.get('redirect_to');
    expect(redirectTo).not.toBeNull();
    expect(new URL(redirectTo ?? '').searchParams.get('state')).toBeString();
    const user = await auth.handleCallback(callback(opened));
    expect(user.id).toBe('user-1');
    const exchange = JSON.parse(body) as Record<string, string>;
    expect(exchange.auth_code).toBe('auth-code');
    expect(exchange.code_verifier).toBeString();
    expect(requestUrl).not.toContain('auth-code');
    expect(store.value?.accountId).toBe('user-1');
    await expect(auth.handleCallback(callback(opened))).rejects.toBeInstanceOf(
      InvalidAuthCallbackError,
    );
  });

  test('refuses a foreign, modified, or reused callback', async () => {
    let opened = '';
    const auth = new SupabaseNativeAuth({
      config,
      store: new Store(),
      openBrowser: async (url) => {
        opened = url;
      },
      fetch: async () => Response.json(tokenResponse()),
    });
    await auth.beginOAuth('google');
    const valid = new URL(callback(opened));
    await expect(
      auth.handleCallback(
        `https://foreign.test/callback?code=x&state=${valid.searchParams.get('state')}`,
      ),
    ).rejects.toBeInstanceOf(InvalidAuthCallbackError);
    await auth.beginOAuth('google');
    const changedScope = new URL(callback(opened));
    changedScope.searchParams.set('apiOrigin', 'https://foreign.test');
    await expect(auth.handleCallback(changedScope.toString())).rejects.toBeInstanceOf(
      InvalidAuthCallbackError,
    );
    await auth.beginOAuth('google');
    const oneUse = callback(opened);
    await auth.handleCallback(oneUse);
    await expect(auth.handleCallback(oneUse)).rejects.toBeInstanceOf(InvalidAuthCallbackError);
  });

  test('refuses callback fragments and duplicate state or code values', async () => {
    let opened = '';
    const auth = new SupabaseNativeAuth({
      config,
      store: new Store(),
      openBrowser: async (url) => {
        opened = url;
      },
      fetch: async () => Response.json(tokenResponse()),
    });
    await auth.beginOAuth('google');
    const fragment = new URL(callback(opened));
    fragment.hash = 'access_token=must-not-be-used';
    await expect(auth.handleCallback(fragment.toString())).rejects.toBeInstanceOf(
      InvalidAuthCallbackError,
    );
    await auth.beginOAuth('google');
    const duplicateState = new URL(callback(opened));
    duplicateState.searchParams.append('state', duplicateState.searchParams.get('state') ?? '');
    await expect(auth.handleCallback(duplicateState.toString())).rejects.toBeInstanceOf(
      InvalidAuthCallbackError,
    );
    await auth.beginOAuth('google');
    const duplicateCode = new URL(callback(opened));
    duplicateCode.searchParams.append('code', 'second-code');
    await expect(auth.handleCallback(duplicateCode.toString())).rejects.toBeInstanceOf(
      InvalidAuthCallbackError,
    );
  });

  test('concurrent requests refresh once and persist the rotated record once', async () => {
    const store = new Store();
    let opened = '';
    const requests: string[] = [];
    const auth = new SupabaseNativeAuth({
      config,
      store,
      openBrowser: async (url) => {
        opened = url;
      },
      fetch: async (input) => {
        requests.push(String(input));
        return Response.json(tokenResponse());
      },
    });
    auth.setPersistenceEnabled(true);
    await auth.beginOAuth('google');
    await auth.handleCallback(callback(opened));
    requests.length = 0;
    const tokens = await Promise.all([auth.refresh(), auth.refresh(), auth.refresh()]);
    expect(tokens).toEqual(['access-1', 'access-1', 'access-1']);
    expect(requests).toHaveLength(1);
    expect(store.saves).toBe(2);
  });

  test('logout invalidates a late refresh and leaves memory and secure store empty', async () => {
    const store = new Store();
    let opened = '';
    let refreshCall = 0;
    const waiting = deferred<Response>();
    const auth = new SupabaseNativeAuth({
      config,
      store,
      openBrowser: async (url) => {
        opened = url;
      },
      fetch: async (input) => {
        if (String(input).includes('/logout')) {
          return new Response(null, { status: 204 });
        }
        refreshCall += 1;
        return refreshCall === 1 ? Response.json(tokenResponse()) : waiting.promise;
      },
    });
    auth.setPersistenceEnabled(true);
    await auth.beginOAuth('google');
    await auth.handleCallback(callback(opened));
    const refresh = auth.refresh();
    await auth.signOut();
    waiting.resolve(Response.json(tokenResponse('user-1', 'late-access', 'late-refresh')));
    await refresh;
    expect(auth.accessToken).toBeNull();
    expect(store.value).toBeNull();
  });

  test('logout invalidates a late authorization-code exchange', async () => {
    const store = new Store();
    let opened = '';
    const exchange = deferred<Response>();
    const auth = new SupabaseNativeAuth({
      config,
      store,
      openBrowser: async (url) => {
        opened = url;
      },
      fetch: async () => exchange.promise,
    });
    auth.setPersistenceEnabled(true);
    await auth.beginOAuth('google');
    const callbackRequest = auth.handleCallback(callback(opened));
    await auth.signOut();
    exchange.resolve(Response.json(tokenResponse()));
    await expect(callbackRequest).rejects.toThrow(/invalidated by a session change/);
    expect(auth.accessToken).toBeNull();
    expect(store.value).toBeNull();
  });

  test('changing project invalidates a pending refresh completion', async () => {
    const store = new Store();
    let opened = '';
    let refreshCall = 0;
    const waiting = deferred<Response>();
    const auth = new SupabaseNativeAuth({
      config,
      store,
      openBrowser: async (url) => {
        opened = url;
      },
      fetch: async () => {
        refreshCall += 1;
        return refreshCall === 1 ? Response.json(tokenResponse()) : waiting.promise;
      },
    });
    auth.setPersistenceEnabled(true);
    await auth.beginOAuth('google');
    await auth.handleCallback(callback(opened));
    const refresh = auth.refresh();
    await auth.switchScope({ ...config, supabaseProjectRef: 'other-project' });
    waiting.resolve(Response.json(tokenResponse('user-1', 'old-access', 'old-refresh')));
    await refresh;
    expect(auth.accessToken).toBeNull();
    expect(store.value).toBeNull();
  });

  test('changing environment and API origin invalidates a pending refresh completion', async () => {
    const store = new Store();
    let opened = '';
    let refreshCall = 0;
    const waiting = deferred<Response>();
    const auth = new SupabaseNativeAuth({
      config,
      store,
      openBrowser: async (url) => {
        opened = url;
      },
      fetch: async () => {
        refreshCall += 1;
        return refreshCall === 1 ? Response.json(tokenResponse()) : waiting.promise;
      },
    });
    auth.setPersistenceEnabled(true);
    await auth.beginOAuth('google');
    await auth.handleCallback(callback(opened));
    const refresh = auth.refresh();
    await auth.switchScope({
      ...config,
      environment: 'production',
      apiOrigin: 'https://production.example.test',
    });
    waiting.resolve(
      Response.json(tokenResponse('user-1', 'old-target-access', 'old-target-refresh')),
    );
    await refresh;
    expect(auth.accessToken).toBeNull();
    expect(store.value).toBeNull();
  });

  test('account changes require global logout before a new PKCE attempt', async () => {
    const store = new Store();
    let opened = '';
    let identities = 0;
    const auth = new SupabaseNativeAuth({
      config,
      store,
      openBrowser: async (url) => {
        opened = url;
      },
      fetch: async (input) => {
        if (String(input).includes('/logout')) {
          return new Response(null, { status: 204 });
        }
        identities += 1;
        return Response.json(tokenResponse(`user-${identities}`));
      },
    });
    auth.setPersistenceEnabled(true);
    await auth.beginOAuth('google');
    await auth.handleCallback(callback(opened));
    await expect(auth.beginOAuth('google')).rejects.toThrow(/Sign out before/);
    await auth.signOut();
    await auth.beginOAuth('google');
    await auth.handleCallback(callback(opened));
    expect(store.value?.accountId).toBe('user-2');
  });

  test('restores expired access tokens through the refresh endpoint', async () => {
    const store = new Store();
    const now = 1_700_000_000_000;
    const scope = {
      environment: config.environment,
      supabaseProjectRef: config.supabaseProjectRef,
      apiOrigin: config.apiOrigin,
      accountId: 'user-1',
    };
    await store.save(scope, {
      accountId: scope.accountId,
      supabaseProjectRef: scope.supabaseProjectRef,
      apiOrigin: scope.apiOrigin,
      version: 1,
      accessToken: 'expired',
      refreshToken: 'refresh-old',
      expiresAt: now - 1,
    });
    const auth = new SupabaseNativeAuth({
      config,
      store,
      openBrowser: async () => {},
      now: () => now,
      fetch: async () => Response.json(tokenResponse()),
    });
    expect((await auth.restore())?.id).toBe('user-1');
    expect(auth.accessToken).toBe('access-1');
  });

  test('surfaces a legacy credential as an explicit reauthentication outcome', async () => {
    const store = new Store();
    store.knownAccounts = async () => ['legacy-user'];
    store.load = async () => {
      throw new ReauthenticationRequiredError();
    };
    const auth = new SupabaseNativeAuth({ config, store, openBrowser: async () => {} });
    expect(await auth.restore()).toBeNull();
    expect(auth.requiresReauthentication).toBe(true);
  });
});

import { beforeEach, expect, mock, test } from 'bun:test';
import type { CookieMethodsServer } from '@supabase/ssr';

let adapter: CookieMethodsServer;
let failureStatus: number | undefined;
const cacheHeaders = { 'Cache-Control': 'private, no-store', Pragma: 'no-cache', Expires: '0' };
const writeSession = () =>
  adapter.setAll?.(
    [{ name: 'sb-session', value: 'local-session', options: { path: '/' } }],
    cacheHeaders,
  );
const signIn = mock(async () => {
  await writeSession();
  return {
    data: { user: { id: 'user', email: 'a@example.test' } },
    error: failureStatus === undefined ? null : { message: 'refused', status: failureStatus },
  };
});
const reset = mock(async (_email: string, _options: { redirectTo: string }) => ({ error: null }));
const exchange = mock(async () => {
  await writeSession();
  return { error: null };
});
mock.module('@supabase/ssr', () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: CookieMethodsServer }) => {
    adapter = options.cookies;
    return {
      auth: {
        signInWithPassword: signIn,
        exchangeCodeForSession: exchange,
        resetPasswordForEmail: reset,
      },
    };
  },
}));
const { POST, GET, PUT } = await import('../../routes/api/auth/[...all]/+server.ts');
const { GET: callback } = await import('../../routes/auth/callback/+server.ts');
const { submitAuthAction } = await import('./auth_action.ts');

const makeEvent = (endpoint: string, body: unknown = {}, method = 'POST') => {
  const url = new URL(`http://localhost/api/auth/${endpoint}`);
  const responseHeaders = new Headers();
  return {
    url,
    request: new Request(url, {
      method,
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    }),
    cookies: { getAll: () => [], set: mock(() => {}) },
    locals: {
      container: {
        backendProfile: 'supabase',
        baseUrl: url.origin,
        supabase: {
          url: 'http://localhost:54321',
          anonKey: 'local-anon',
          serviceRoleKey: 'local-admin',
        },
      },
      context: { responseHeaders },
      supabaseIdentity: { user: { id: 'user' } },
      user: null,
    },
  };
};
const invoke = (event: ReturnType<typeof makeEvent>) =>
  POST(event as unknown as Parameters<typeof POST>[0]);
beforeEach(() => {
  failureStatus = undefined;
  signIn.mockClear();
  exchange.mockClear();
  reset.mockClear();
});

test('auth rejects extra fields, malformed JSON, non-object bodies and oversized streams', async () => {
  for (const body of [{ email: 'a@example.test', password: 'password', admin: true }, [], null]) {
    expect((await invoke(makeEvent('sign-in/email', body))).status).toBe(400);
  }
  const malformed = makeEvent('sign-in/email');
  malformed.request = new Request(malformed.url, { method: 'POST', body: '{' });
  expect((await invoke(malformed)).status).toBe(400);
  const oversized = makeEvent('sign-in/email', { email: 'a'.repeat(17 * 1024), password: 'p' });
  expect((await invoke(oversized)).status).toBe(413);
  expect(signIn).not.toHaveBeenCalled();
});

test('auth preserves GET and refuses other methods before processing a body', async () => {
  const get = makeEvent('get-session', undefined, 'GET');
  expect((await GET(get as unknown as Parameters<typeof GET>[0])).status).toBe(200);
  const put = makeEvent('sign-in/email', {}, 'PUT');
  expect((await PUT(put as unknown as Parameters<typeof PUT>[0])).status).toBe(405);
  expect(signIn).not.toHaveBeenCalled();
  expect((await invoke(makeEvent('constructor'))).status).toBe(404);
});

test('email-change distinguishes a signed-in invalid email from missing identity', async () => {
  const event = makeEvent('account/email-change', { email: 42 });
  expect((await invoke(event)).status).toBe(422);
  Object.assign(event.locals, { supabaseIdentity: null });
  expect(
    (
      await invoke({
        ...event,
        request: new Request(event.url, { method: 'POST', body: '{"email":42}' }),
      })
    ).status,
  ).toBe(401);
});

test('recovery links use the configured origin rather than the request host', async () => {
  const event = makeEvent('request-password-reset', { email: 'a@example.test' });
  event.locals.container.baseUrl = 'https://app.example.test';
  const response = await invoke(event);
  expect(response.status).toBe(200);
  expect(reset).toHaveBeenCalledWith('a@example.test', {
    redirectTo: 'https://app.example.test/auth/callback?next=%2Freset-password',
  });
});

test('auth cookie writes retain provider headers on success and error responses', async () => {
  for (const status of [undefined, 429]) {
    failureStatus = status;
    const event = makeEvent('sign-in/email', { email: 'a@example.test', password: 'password' });
    const response = await invoke(event);
    expect(response.status).toBe(status ?? 200);
    expect(event.cookies.set).toHaveBeenCalledTimes(1);
    for (const [name, value] of Object.entries(cacheHeaders)) {
      expect(response.headers.get(name)).toBe(value);
    }
  }
});

test('form-action cookie writes forward provider headers even on failure', async () => {
  for (const status of [undefined, 429]) {
    failureStatus = status;
    const event = makeEvent('sign-in/email');
    const result = submitAuthAction(
      event.locals.container as never,
      event.request,
      event.cookies as never,
      'sign-in/email',
      { email: 'a@example.test', password: 'password' },
      event.locals.context.responseHeaders,
    );
    if (status === undefined) {
      expect(await result).toBe(1);
    } else {
      await expect(result).rejects.toMatchObject({ status });
    }
    for (const [name, value] of Object.entries(cacheHeaders)) {
      expect(event.locals.context.responseHeaders.get(name)).toBe(value);
    }
  }
});

test('invalid callbacks never exchange the code or write session cookies', async () => {
  const event = makeEvent('unused', undefined, 'GET');
  event.url = new URL('http://localhost/auth/callback?code=local-code&next=https://evil.test');
  await expect(callback(event as unknown as Parameters<typeof callback>[0])).rejects.toMatchObject({
    location: '/login?error=invalid_callback',
  });
  expect(exchange).not.toHaveBeenCalled();
  expect(event.cookies.set).not.toHaveBeenCalled();
  event.url = new URL('http://localhost/auth/callback?code=local-code&next=/verify-email');
  await expect(callback(event as unknown as Parameters<typeof callback>[0])).rejects.toMatchObject({
    location: '/verify-email',
  });
  expect(exchange).toHaveBeenCalledWith('local-code');
  expect(event.cookies.set).toHaveBeenCalledTimes(1);
  expect(event.locals.context.responseHeaders.get('cache-control')).toBe('private, no-store');
});

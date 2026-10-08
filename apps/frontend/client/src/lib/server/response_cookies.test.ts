// apps/frontend/client/src/lib/server/response_cookies.test.ts
//
// What this file tests is the forwarding, not the parsing: `parse` belongs to SvelteKit,
// and re-implementing it here would only test the copy.
//
// The real header — Supabase Auth 1.7.6's
//
//   Supabase Auth.session_token=<token>; Max-Age=604800; Path=/; HttpOnly; Secure; SameSite=Lax
//
// — is exercised end to end by `apps/e2e/tests/auth.spec.ts`, in a browser with
// scripting disabled, which signs in for real and asserts the session is then usable. A
// unit test with a stubbed parser could not have caught the double-encoded value that
// test found: a stored cookie that authenticated nothing.

import { describe, expect, test } from 'bun:test';
import { applySetCookies, type CookieSink } from './response_cookies.ts';

/** SvelteKit's parsed-cookie and options shapes, taken from the signatures in use. */
type ParsedCookie = ReturnType<CookieSink['parse']>;
type SetOptions = Parameters<CookieSink['set']>[2];

interface Applied {
  name: string;
  value: string;
  options: SetOptions;
}

const stub = (): { sink: CookieSink; applied: Applied[] } => {
  const applied: Applied[] = [];
  const sink: CookieSink = {
    // A stand-in for `cookie.parseSetCookie`, reduced to the attributes these tests
    // care about. Returning the real parsed shape is the point: the forwarding must not
    // depend on how a header becomes a name, a value and attributes.
    parse: (setCookie) => {
      const [pair = '', ...attributes] = setCookie.split(';');
      const separator = pair.indexOf('=');
      const parsed: ParsedCookie = {
        name: pair.slice(0, Math.max(separator, 0)).trim(),
        value: separator < 0 ? undefined : pair.slice(separator + 1).trim(),
      };
      for (const attribute of attributes) {
        const at = attribute.indexOf('=');
        const key = attribute
          .slice(0, at < 0 ? undefined : at)
          .trim()
          .toLowerCase();
        const value = at < 0 ? '' : attribute.slice(at + 1).trim();
        if (key === 'max-age') {
          parsed.maxAge = Number(value);
        } else if (key === 'path') {
          parsed.path = value;
        } else if (key === 'httponly') {
          parsed.httpOnly = true;
        } else if (key === 'secure') {
          parsed.secure = true;
        } else if (key === 'samesite') {
          parsed.sameSite = value.toLowerCase() as 'lax';
        }
      }
      return parsed;
    },
    set: (name, value, options) => applied.push({ name, value, options }),
  };
  return { sink, applied };
};

const headersOf = (...setCookies: string[]): Headers => {
  const headers = new Headers();
  for (const value of setCookies) {
    headers.append('set-cookie', value);
  }
  return headers;
};

describe('moving Supabase Auth cookies onto an action response', () => {
  test('a parsed header is applied under its own name and attributes', () => {
    const { sink, applied } = stub();

    const count = applySetCookies(
      sink,
      headersOf(
        'Supabase Auth.session_token=token-value; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax',
      ),
    );

    expect(count).toBe(1);
    expect(applied[0]?.name).toBe('Supabase Auth.session_token');
    expect(applied[0]?.value).toBe('token-value');
    expect(applied[0]?.options).toEqual({
      maxAge: 604800,
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
    });
  });

  test('every cookie on the response is applied, not just the first', () => {
    const { sink, applied } = stub();

    const count = applySetCookies(
      sink,
      headersOf('Supabase Auth.session_token=one; Path=/', 'Supabase Auth.state=two; Path=/'),
    );

    // A sign-in that clears a state cookie has to clear it; leaving the old one behind is
    // a stale value the next request still carries. Reading `headers.get('set-cookie')`
    // instead of `getSetCookie()` would apply one comma-joined cookie here.
    expect(count).toBe(2);
    expect(applied.map((entry) => entry.name)).toEqual([
      'Supabase Auth.session_token',
      'Supabase Auth.state',
    ]);
  });

  test('the value is handed over exactly as parsed, not re-encoded', () => {
    const { sink, applied } = stub();

    // The assertion that matters: whatever `parse` produced is what `set` receives. A
    // second `encodeURIComponent` here is what turned `%3D` into `%253D` and produced a
    // session cookie that authenticated nobody.
    applySetCookies(sink, headersOf('Supabase Auth.session_token=a%3D; Path=/'));

    expect(applied[0]?.value).toBe('a%3D');
  });

  test('a sign-in that set no cookie is reported as zero, not as success', () => {
    const { sink, applied } = stub();

    expect(applySetCookies(sink, headersOf())).toBe(0);
    expect(applied).toEqual([]);
  });

  test('an empty value is a deletion and is applied, not skipped', () => {
    const { sink, applied } = stub();

    const count = applySetCookies(sink, headersOf('Supabase Auth.state=; Max-Age=0; Path=/'));

    // `name=` with nothing after it clears a cookie. Skipping it would leave a stale
    // value in the browser that the next request still carries.
    expect(count).toBe(1);
    expect(applied[0]?.value).toBe('');
  });

  test('a header that is not name=value is not counted as applied', () => {
    const { sink, applied } = stub();

    expect(applySetCookies(sink, headersOf('garbage'))).toBe(0);
    expect(applied).toEqual([]);
  });
});

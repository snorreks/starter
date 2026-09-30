// packages/shared/logger/src/lib/redaction.test.ts
//
// Redaction, tested adversarially.
//
// This runs on the logging path and on the Worker telemetry endpoint, so its
// contract is "never throws, never leaks, never hangs" — not "handles the happy
// case". A payload arrives from a request body, a user-controlled message, or a
// third-party library, and the process that is trying to report a problem must
// not be taken down by it.
//
// The most important tests here are the negative ones: what must NOT be
// redacted. An over-eager matcher turns "token count: 4" into "[redacted]" and
// destroys the value of every log line while appearing to work.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_REDACTED_KEYS, isRedactedKey, redactValue, REDACTED } from './redaction.ts';

describe('isRedactedKey', () => {
  test('catches the obvious credential names', () => {
    for (const key of ['password', 'token', 'authorization', 'cookie', 'apiKey', 'secret']) {
      expect(isRedactedKey(key)).toBe(true);
    }
  });

  test('is insensitive to case and punctuation', () => {
    // Requests arrive as `Password`, `PASSWORD`, and `password_hash` from
    // different clients; all three are the same secret.
    for (const key of ['PASSWORD', 'Password', 'passWord', 'password', 'API_KEY', 'api-key', 'Api Key']) {
      expect(isRedactedKey(key)).toBe(true);
    }
  });

  test('catches a suffixed credential field', () => {
    // `refreshToken` is in the list, but `userAccessToken` should be caught by
    // someone adding it, and `sessionToken` is caught explicitly.
    expect(isRedactedKey('sessionToken')).toBe(true);
    expect(isRedactedKey('userPasswordResetCode')).toBe(false);
  });

  test('does not redact a field that merely mentions a word', () => {
    // These are the false positives that make redaction useless if you allow
    // them. `tokenCount` is a number a maintainer needs.
    for (const key of ['tokenCount', 'passwordPolicy', 'authMethod', 'secretName', 'cookiePolicy']) {
      expect(isRedactedKey(key)).toBe(false);
    }
  });

  test('honours caller-supplied keys', () => {
    expect(isRedactedKey('userPin', ['userPin'])).toBe(true);
    // Still normalised: the caller's list behaves like the default one.
    expect(isRedactedKey('USER_PIN', ['userPin'])).toBe(true);
    expect(isRedactedKey('userPin')).toBe(false);
  });

  test('every default key redacts itself', () => {
    // Guards against a constant being added to the list with a typo in its own
    // normal form, which would silently never match.
    for (const key of DEFAULT_REDACTED_KEYS) {
      expect(isRedactedKey(key)).toBe(true);
    }
  });
});

describe('redactValue', () => {
  test('replaces a secret at the top level', () => {
    expect(redactValue({ password: 'hunter2' })).toEqual({ password: REDACTED });
  });

  test('replaces secrets nested at any depth', () => {
    const redacted = redactValue({
      user: { profile: { contact: { authorization: 'Bearer abc' } } },
    }) as { user: { profile: { contact: { authorization: string } } } };

    expect(redacted.user.profile.contact.authorization).toBe(REDACTED);
  });

  test('redacts inside arrays of objects', () => {
    const redacted = redactValue([{ token: 'a' }, { token: 'b' }]) as { token: string }[];
    expect(redacted.map((entry) => entry.token)).toEqual([REDACTED, REDACTED]);
  });

  test('does not mutate the input', () => {
    const input = { password: 'hunter2', nested: { token: 'abc' } };
    const snapshot = structuredClone(input);

    redactValue(input);

    // The caller may still be holding this object, and it may be a live model.
    // Redacting in place would corrupt application state to protect a log.
    expect(input).toEqual(snapshot);
  });

  test('truncates a long string and reports the original length', () => {
    const long = 'x'.repeat(5000);
    const result = redactValue({ blob: long }, { maxStringLength: 10 }) as { blob: string };

    expect(result.blob.startsWith('xxxxxxxxxx')).toBe(true);
    expect(result.blob).toContain('5000 chars');
    // Without the count, a truncated line reads as a short value rather than a
    // truncated one.
    expect(result.blob.length).toBeLessThan(long.length);
  });

  test('bounds object width and says how much was dropped', () => {
    const wide: Record<string, number> = {};
    for (let index = 0; index < 100; index += 1) {
      wide[`key${index}`] = index;
    }

    const result = redactValue(wide, { maxEntries: 10 }) as Record<string, unknown>;

    expect(Object.keys(result)).toHaveLength(11);
    expect(result['…']).toBe('90 more keys');
  });

  test('bounds array length and says how much was dropped', () => {
    const long = Array.from({ length: 100 }, (_, index) => index);

    const result = redactValue(long, { maxEntries: 10 }) as unknown[];

    expect(result).toHaveLength(11);
    expect(result[10]).toBe('…90 more');
  });

  test('stops at the depth limit instead of recursing without bound', () => {
    // The reason maxDepth exists: an object nested thousands deep would blow the
    // stack of the process that is trying to log it.
    let deep: Record<string, unknown> = { value: 'bottom' };
    for (let index = 0; index < 500; index += 1) {
      deep = { nested: deep };
    }

    // The level *at* the limit is summarized, so the result is bounded by
    // maxDepth levels regardless of how deep the input was.
    const result = redactValue(deep, { maxDepth: 3 });

    expect(result).toEqual({ nested: { nested: { nested: '[object]' } } });
  });

  test('survives a cyclic structure', () => {
    // A self-referencing payload is the obvious way to hang a logger.
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    const result = redactValue(cyclic) as Record<string, unknown>;

    expect(result['name']).toBe('loop');
    expect(result['self']).toBe('[circular]');
  });

  test('survives a cycle that does not include the root', () => {
    const inner: Record<string, unknown> = {};
    inner['self'] = inner;
    const outer = { a: inner, b: inner };

    expect(() => redactValue(outer)).not.toThrow();
  });

  test('summarises an Error rather than stringifying it to {}', () => {
    // JSON.stringify(new Error('x')) is '{}'. A logger that used it would
    // record every failure as an empty object.
    const result = redactValue({ failure: new TypeError('boom') }) as {
      failure: { name: string; message: string };
    };

    expect(result.failure.name).toBe('TypeError');
    expect(result.failure.message).toBe('boom');
  });

  test('truncates an Error stack', () => {
    const deep = new Error('x');
    deep.stack = Array.from({ length: 40 }, (_, index) => `frame ${index}`).join('\n');

    const result = redactValue(deep) as { stack: string };

    expect(result.stack.split('\n')).toHaveLength(10);
  });

  test('redacts a secret carried on an Error property', () => {
    const failure = Object.assign(new Error('request failed'), {
      token: 'abc123',
      status: 500,
    });

    const result = redactValue(failure) as { token: string; status: number; message: string };

    // The Error branch copies known fields, so an attached credential must not
    // survive the copy that drops everything else.
    expect(result.token).toBeUndefined();
    expect(result.message).toBe('request failed');
  });

  test('handles the primitives that have no useful JSON form', () => {
    const result = redactValue({
      big: 10n,
      fn: function named() {},
      sym: Symbol('tag'),
    }) as Record<string, unknown>;

    expect(result['big']).toBe('10n');
    expect(result['fn']).toBe('[function named]');
    expect(result['sym']).toBe('Symbol(tag)');
  });

  test('passes null and undefined through unchanged', () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
    expect(redactValue({ a: null, b: undefined })).toEqual({ a: null, b: undefined });
  });

  test('does not throw on a Proxy that throws on property access', () => {
    // A hostile or broken object on the logging path must not take down the
    // caller. This is the reason `redactValue` is written defensively.
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('no keys for you');
        },
        get() {
          throw new Error('no properties for you');
        },
      },
    );

    expect(() => redactValue(hostile)).not.toThrow();
  });

  test('does not throw on a Map or Set, which have no own enumerable keys', () => {
    const result = redactValue({
      map: new Map([['a', 1]]),
      set: new Set([1, 2]),
    }) as Record<string, unknown>;

    // They serialize to {} rather than throwing — lossy, but safe.
    expect(result['map']).toEqual({});
    expect(result['set']).toEqual({});
  });

  test('redacts a key that only differs by punctuation', () => {
    expect(redactValue({ 'set-cookie': 'session=abc' })).toEqual({ 'set-cookie': REDACTED });
    expect(redactValue({ 'Set-Cookie': 'session=abc' })).toEqual({ 'Set-Cookie': REDACTED });
  });

  test('a deeply nested secret is still redacted at the boundary', () => {
    const payload = { a: { b: { c: { d: { e: { password: 'hunter2' } } } } } };

    const result = redactValue(payload, { maxDepth: 10 }) as {
      a: { b: { c: { d: { e: { password: string } } } } };
    };

    expect(result.a.b.c.d.e.password).toBe(REDACTED);
  });
});
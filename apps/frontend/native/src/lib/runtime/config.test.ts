// apps/frontend/native/src/lib/runtime/config.test.ts
//
// The configuration refuses, and each refusal is a failure someone actually made.

import { describe, expect, test } from 'bun:test';
import { DEFAULT_DEV_API_ORIGIN, NativeConfigError, resolveApiOrigin } from './config.ts';

describe('the API origin a packaged build talks to', () => {
  test('a development build with nothing configured talks to the local Worker', () => {
    expect(resolveApiOrigin({ raw: undefined, dev: true })).toBe(DEFAULT_DEV_API_ORIGIN);
    expect(resolveApiOrigin({ raw: '   ', dev: true })).toBe(DEFAULT_DEV_API_ORIGIN);
  });

  test('a packaged build with nothing configured refuses rather than guessing', () => {
    // The failure this prevents: the app starts, every request goes to a loopback
    // port nothing is listening on, and the symptom is "sign-in does nothing".
    expect(() => resolveApiOrigin({ raw: undefined, dev: false })).toThrow(NativeConfigError);
    expect(() => resolveApiOrigin({ raw: undefined, dev: false })).toThrow(/no default/i);
  });

  test('a packaged build refuses plain http', () => {
    // A bearer token on a cleartext request is the whole reason this is refused,
    // and the message has to say which value was wrong.
    expect(() => resolveApiOrigin({ raw: 'http://api.example.test', dev: false })).toThrow(/https/);
    // Including for loopback: localhost is not a safe place for a credential
    // merely because it is the developer's own machine.
    expect(() => resolveApiOrigin({ raw: 'http://127.0.0.1:5173', dev: false })).toThrow(
      NativeConfigError,
    );
  });

  test('a development build may use http only to loopback', () => {
    expect(resolveApiOrigin({ raw: 'http://localhost:5173', dev: true })).toBe(
      'http://localhost:5173',
    );
    expect(resolveApiOrigin({ raw: 'http://[::1]:5173', dev: true })).toBe('http://[::1]:5173');
    // A plain-http LAN address is refused unless it was *named* as the device
    // host. A phone's own address is not the developer's machine, and an origin
    // that silently became a neighbour's is how a bearer token ends up on the
    // next machine over.
    expect(() => resolveApiOrigin({ raw: 'http://192.168.1.20:8787', dev: true })).toThrow(
      /--host/,
    );
  });

  test('naming the device host moves the origin onto the machine, keeping the port', () => {
    expect(
      resolveApiOrigin({ raw: 'http://127.0.0.1:5173', dev: true, devHost: '192.168.1.20' }),
    ).toBe('http://192.168.1.20:5173');
    // And it works for an https origin too, which is the case a developer with a
    // tunnel, or a real development deployment, is in.
    expect(
      resolveApiOrigin({ raw: 'https://api.example.test', dev: true, devHost: 'devbox.local' }),
    ).toBe('https://devbox.local');
  });

  test('a device host in a packaged build is refused, and says why', () => {
    // This is the whole boundary: a bundle compiled with one machine's address on
    // it points every user at that machine, and nothing about the artifact would
    // show it.
    expect(() =>
      resolveApiOrigin({ raw: 'https://api.example.test', dev: false, devHost: '192.168.1.20' }),
    ).toThrow(/only for/);
  });

  test('a device host cannot carry a scheme that is not http or https', () => {
    // `URL` accepts `file:`, `ws:` and `data:`, and `.origin` is the string
    // `"null"` for the first two — so without this check a device host would
    // return `"null"` and produce a client that addresses nothing.
    // `file://host` rather than `file:///etc/passwd`: the latter is refused a
    // line earlier for carrying a path, which is a different and also correct
    // message. This test is about the scheme.
    for (const raw of ['file://host', 'ws://127.0.0.1:5173', 'ftp://example.test']) {
      expect(() => resolveApiOrigin({ raw, dev: true, devHost: '192.168.1.20' })).toThrow(
        NativeConfigError,
      );
    }
    // And the message names the scheme, not just the host.
    expect(() =>
      resolveApiOrigin({ raw: 'file://host', dev: true, devHost: '192.168.1.20' }),
    ).toThrow(/Only http and https/);
  });

  test('a device host must be a bare host, so it cannot smuggle a port or a path', () => {
    for (const host of ['http://192.168.1.20', '192.168.1.20:5173', 'host/path', '-bad']) {
      expect(() =>
        resolveApiOrigin({ raw: 'http://127.0.0.1:5173', dev: true, devHost: host }),
      ).toThrow(NativeConfigError);
    }
    // Empty is "not configured", so it falls back to the loopback rule above
    // rather than being an error of its own.
    expect(resolveApiOrigin({ raw: 'http://127.0.0.1:5173', dev: true, devHost: '' })).toBe(
      'http://127.0.0.1:5173',
    );
  });

  test('a relative value is refused rather than resolved against the shell origin', () => {
    // `new URL('/api', 'tauri://localhost')` would succeed and produce a request
    // against the bundled file protocol, which answers HTML.
    expect(() => resolveApiOrigin({ raw: '/api', dev: true })).toThrow(/absolute URL/i);
    expect(() => resolveApiOrigin({ raw: 'api.example.test', dev: true })).toThrow(
      NativeConfigError,
    );
  });

  test('a path, a query and a fragment are each refused', () => {
    // `https://host/api` + `/api/notes` is `https://host/api/api/notes`, which
    // 404s; a trailing slash alone is not a path and must not be refused.
    expect(resolveApiOrigin({ raw: 'https://api.example.test/', dev: false })).toBe(
      'https://api.example.test',
    );
    expect(() => resolveApiOrigin({ raw: 'https://api.example.test/api', dev: false })).toThrow(
      /origin only/i,
    );
    expect(() => resolveApiOrigin({ raw: 'https://api.example.test?x=1', dev: false })).toThrow(
      NativeConfigError,
    );
    expect(() => resolveApiOrigin({ raw: 'https://api.example.test#f', dev: false })).toThrow(
      NativeConfigError,
    );
  });

  test('a non-http scheme is refused even when the URL parses', () => {
    // `file://` and `tauri://` both parse. A token posted to either is a token
    // posted to nowhere, or to a file.
    expect(() => resolveApiOrigin({ raw: 'file:///etc/passwd', dev: false })).toThrow(
      NativeConfigError,
    );
    expect(() => resolveApiOrigin({ raw: 'tauri://localhost', dev: false })).toThrow(
      NativeConfigError,
    );
  });

  test('the resolved value is normalized, so a scope key cannot be spelled two ways', () => {
    expect(resolveApiOrigin({ raw: 'https://API.Example.test:443', dev: false })).toBe(
      'https://api.example.test',
    );
  });
});

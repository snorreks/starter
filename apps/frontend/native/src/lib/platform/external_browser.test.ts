// apps/frontend/native/src/lib/platform/external_browser.test.ts
//
// What this app is willing to hand to the operating system.

import { describe, expect, test } from 'bun:test';
import {
  assertOpenable,
  createExternalBrowser,
  ExternalBrowserRefused,
} from './external_browser.ts';

const ORIGIN = 'https://api.example.test';

describe('the URL allowance', () => {
  test('accepts an https URL on the configured origin', () => {
    const url = assertOpenable('https://api.example.test/device?user_code=ABCD-EFGH', ORIGIN);
    expect(url.searchParams.get('user_code')).toBe('ABCD-EFGH');
  });

  test('refuses a scheme that is not https, whatever the origin', () => {
    // `openUrl` will pass all of these to the OS, and the OS will act on them.
    expect(() => assertOpenable('http://api.example.test/device', ORIGIN)).toThrow(
      ExternalBrowserRefused,
    );
    expect(() => assertOpenable('file:///etc/passwd', ORIGIN)).toThrow(ExternalBrowserRefused);
    expect(() => assertOpenable('tauri://localhost/device', ORIGIN)).toThrow(
      ExternalBrowserRefused,
    );
    expect(() => assertOpenable('javascript:alert(1)', ORIGIN)).toThrow(ExternalBrowserRefused);
  });

  test('refuses another host even over https', () => {
    // The URL arrives in a response body. A provider that answered with somebody
    // else's origin would otherwise get the user to open a page carrying a sign-in
    // code, from this app, in their real browser.
    expect(() => assertOpenable('https://evil.test/device', ORIGIN)).toThrow(
      /only hands URLs belonging to/,
    );
  });

  test('refuses a value that is not a URL at all', () => {
    expect(() => assertOpenable('/device', ORIGIN)).toThrow(/not an absolute URL/);
    expect(() => assertOpenable('', ORIGIN)).toThrow(ExternalBrowserRefused);
  });
});

describe('the capability', () => {
  test('opens an allowed URL through the opener plugin', async () => {
    const opened: string[] = [];
    const browser = createExternalBrowser({
      origin: ORIGIN,
      open: async (url) => {
        opened.push(url);
      },
    });

    await browser.open('https://api.example.test/device?user_code=ABCD-EFGH');

    expect(opened).toEqual(['https://api.example.test/device?user_code=ABCD-EFGH']);
  });

  test('refuses before opening anything', async () => {
    const opened: string[] = [];
    const browser = createExternalBrowser({
      origin: ORIGIN,
      open: async (url) => {
        opened.push(url);
      },
    });

    await expect(browser.open('https://evil.test/device')).rejects.toBeInstanceOf(
      ExternalBrowserRefused,
    );
    expect(opened).toEqual([]);
  });

  test('a missing shell is named, not swallowed', async () => {
    // `bun run native:dev` in a plain browser has no Tauri API. The old behaviour
    // was to fall back to `window.open`, which works in dev and does nothing in the
    // packaged app — so the failure appeared only after release.
    const browser = createExternalBrowser({
      origin: ORIGIN,
      open: async () => {
        throw new Error('window.__TAURI_INTERNALS__ is undefined');
      },
    });

    await expect(browser.open('https://api.example.test/device')).rejects.toThrow(
      /bun run native:dev/,
    );
  });
});

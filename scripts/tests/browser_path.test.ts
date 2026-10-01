// scripts/tests/browser_path.test.ts
//
// Which Chromium the browser lanes will use, and why.
//
// Playwright's cache layout is not one directory, and it is not documented as an
// interface anyone may rely on. But a resolver that assumes a single internal path
// is wrong in the way that matters here: it reports `source: 'none'` on a host
// with a perfectly good browser downloaded, so `doctor` advises installing one
// that is already installed and the browser lane fails on the advice.
//
// So each layout gets a fixture directory, and the resolution is asserted against
// the executable rather than against the path shape.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveBrowser } from '../src/shared/browser_path.ts';

const roots: string[] = [];

const cache = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ms-playwright-'));
  roots.push(dir);
  return dir;
};

const placeExecutable = (root: string, build: string, relative: string): string => {
  const path = join(root, build, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexit 0\n');
  return path;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveBrowser', () => {
  test('finds the Linux chromium extraction', () => {
    const root = cache();
    const expected = placeExecutable(root, 'chromium-1200', 'chrome-linux/chrome');

    const resolved = resolveBrowser({ PLAYWRIGHT_BROWSERS_PATH: root });

    expect(resolved.source).toBe('playwright-download');
    expect(resolved.executable).toBe(expected);
  });

  test('finds the macOS app bundle', () => {
    const root = cache();
    const expected = placeExecutable(
      root,
      'chromium-1200',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    );

    expect(resolveBrowser({ PLAYWRIGHT_BROWSERS_PATH: root }).executable).toBe(expected);
  });

  test('finds the Windows chromium executable', () => {
    const root = cache();
    const expected = placeExecutable(root, 'chromium-1200', 'chrome-win/chrome.exe');

    expect(resolveBrowser({ PLAYWRIGHT_BROWSERS_PATH: root }).executable).toBe(expected);
  });

  test('prefers the headless shell when one is installed', () => {
    // What newer Playwright versions ship and launch for headless runs.
    const root = cache();
    placeExecutable(root, 'chromium-1200', 'chrome-linux/chrome');
    const shell = placeExecutable(root, 'chromium-1200', 'chrome-linux/headless_shell');

    expect(resolveBrowser({ PLAYWRIGHT_BROWSERS_PATH: root }).executable).toBe(shell);
  });

  test('an explicit CHROMIUM_PATH still wins', () => {
    const named = cache();
    placeExecutable(named, 'chromium-1200', 'chrome-linux/chrome');

    const explicit = join(named, 'chromium-1200', 'chrome-linux', 'chrome');
    const resolved = resolveBrowser({
      CHROMIUM_PATH: explicit,
      PLAYWRIGHT_BROWSERS_PATH: named,
    });

    expect(resolved.executable).toBe(explicit);
    expect(resolved.reason).toContain('CHROMIUM_PATH');
  });

  // The pre-fix resolver looked only at `<browsersPath>/chromium`, which is the
  // layout nobody ships: the directory is `chromium-<build>`, and the executable is
  // two levels below that.
  test('a cache holding only a bare `chromium` directory resolves to none', () => {
    const root = cache();
    mkdirSync(join(root, 'chromium'), { recursive: true });

    const resolved = resolveBrowser({ PLAYWRIGHT_BROWSERS_PATH: root });

    expect(resolved.source).toBe('none');
    expect(resolved.executable).toBeNull();
  });

  test('an empty named cache falls through to the default cache', () => {
    // A miss in one cache says nothing about the other: the two are independent
    // roots, and reporting `none` here told a host with a working download that
    // it had no browser.
    const empty = cache();
    const xdg = cache();
    const expected = placeExecutable(xdg, 'ms-playwright/chromium-1234', 'chrome-linux/chrome');
    const saved = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = xdg;
    try {
      const resolved = resolveBrowser({
        PLAYWRIGHT_BROWSERS_PATH: empty,
        XDG_CACHE_HOME: xdg,
      });
      expect(resolved.executable).toBe(expected);
    } finally {
      if (saved === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = saved;
      }
    }
  });

  test('a Nix store root is reported as such', () => {
    const root = cache();
    placeExecutable(root, 'chromium-1200', 'chrome-linux/chrome');

    const resolved = resolveBrowser({ PLAYWRIGHT_BROWSERS_PATH: `/nix/store${root}` });
    // No such directory, so nothing is found — but the reason must name the store,
    // because that is what makes the Playwright download the wrong advice.
    expect(resolved.source).toBe('none');
    expect(resolved.reason).toContain('Nix store');
  });

  test('when nothing is found the reason names where it looked', () => {
    const root = cache();
    const resolved = resolveBrowser({ PLAYWRIGHT_BROWSERS_PATH: root });

    expect(resolved.source).toBe('none');
    expect(resolved.reason).toContain(root);
  });
});

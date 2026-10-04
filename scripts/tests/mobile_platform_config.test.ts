// scripts/tests/mobile_platform_config.test.ts
//
// The committed Tauri configuration, read as bytes.
//
// Everything this file checks is a property of files a reviewer can read, and
// none of it needs an SDK, an emulator or a phone. That is the point: the two
// rules below are the ones that make a development exception *stay* a
// development exception, and the way they get broken is by editing a config
// nobody re-reads.
//
//   1. **No development reachability in shipped configuration.** Android's
//      `usesCleartextTraffic` and iOS's `NSAppTransportSecurity` are the two
//      switches that turn "this app may talk to a laptop over http" into "this
//      app may talk to anything over http". The pinned CLI already scopes
//      Android's to the *debug* build type in its own template; this repository
//      must not add a second, committed one that reaches the release build.
//
//   2. **No desktop window minimum.** `app.windows[].minWidth` is not
//      platform-scoped: Tauri applies the same window configuration to a phone.
//      A 360px floor is a desktop assumption that produces a horizontally
//      scrolling view on a 320dp screen, which is the finding the previous round
//      raised about the snapshot.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/shared/paths.ts';

const CONF = join(REPO_ROOT, 'apps/frontend/native/src-tauri/tauri.conf.json');

interface WindowConfig {
  readonly title?: string;
  readonly minWidth?: number;
  readonly minHeight?: number;
  readonly width?: number;
  readonly height?: number;
}

interface TauriConfig {
  readonly bundle?: {
    readonly android?: Record<string, unknown>;
    readonly iOS?: Record<string, unknown>;
  };
  readonly app?: {
    readonly windows?: WindowConfig[];
    readonly security?: { readonly csp?: string; readonly devCsp?: string };
  };
}

const config = (): TauriConfig => JSON.parse(readFileSync(CONF, 'utf8')) as TauriConfig;

describe('the committed Tauri configuration', () => {
  test('it parses and declares exactly one window', () => {
    const parsed = config();
    expect(parsed.app?.windows?.length).toBe(1);
  });

  test('no window carries a minimum size, because a phone has no window to resize', () => {
    // A `minWidth` here is applied on Android and iOS too, where the "window" is
    // the screen. Anything above the narrowest phone in use is a layout that
    // cannot be shown without horizontal scrolling, and `overflow-x: hidden`
    // would hide the symptom rather than the cause.
    for (const window of config().app?.windows ?? []) {
      expect(window.minWidth).toBeUndefined();
      expect(window.minHeight).toBeUndefined();
    }
  });

  test('the mobile bundle settings exist, so `init` does not have to invent them', () => {
    // `tauri android init` reads these; without them a fresh clone gets whatever
    // the CLI's defaults happen to be that month, and `minSdkVersion` in
    // particular is the number a user's phone either passes or fails.
    expect(config().bundle?.android?.minSdkVersion).toBe(24);
    expect(config().bundle?.android?.versionCode).toBe(1);
    expect(config().bundle?.iOS?.bundleVersion).toBe('1');
    expect(typeof config().bundle?.iOS?.minimumSystemVersion).toBe('string');
  });

  test('a debug APK installs beside a release one instead of replacing it', () => {
    expect(config().bundle?.android?.debugApplicationIdSuffix).toBe('.debug');
  });
});

describe('development reachability is not in shipped configuration', () => {
  const forbidden = [
    'usesCleartextTraffic',
    'networkSecurityConfig',
    'cleartextTrafficPermitted',
    'NSAppTransportSecurity',
    'NSAllowsArbitraryLoads',
    'NSAllowsLocalNetworking',
    'NSExceptionDomains',
  ] as const;

  test('the committed config names none of them', () => {
    const text = readFileSync(CONF, 'utf8');
    for (const key of forbidden) {
      expect(text).not.toContain(key);
    }
  });

  test('and no Info.plist is pointed at, so nothing merges one in', () => {
    // `bundle.iOS.infoPlist` merges a file into the generated Info.plist. This
    // template deliberately leaves it unset: an ATS exception committed here is
    // an ATS exception in the App Store binary.
    expect(config().bundle?.iOS?.infoPlist).toBeUndefined();
  });

  test('the CSP connects to nothing but the shell and the one configured origin', () => {
    // The launcher rewrites connect-src from the resolved API origin at build
    // time, so the committed value must name no origin of its own. An `https:` or
    // `http://*` here would be the round-2 finding about a permissive CSP coming
    // back through the config file rather than through code.
    const csp = config().app?.security?.csp ?? '';
    const connect = csp.split(';').find((directive) => directive.trim().startsWith('connect-src'));
    expect(connect).toBeDefined();
    for (const source of (connect ?? '').trim().split(/\s+/).slice(1)) {
      expect(['default-src', "'self'", 'ipc:', 'http://ipc.localhost']).toContain(source);
    }
  });

  test('the committed CSP allows no plain http beyond the local IPC channel', () => {
    const csp = config().app?.security?.csp ?? '';
    expect(csp).not.toContain('https:');
    expect(csp).not.toContain('http://*');
    const plain = csp.match(/http:\/\/[^;\s]+/g) ?? [];
    expect(plain.sort()).toEqual(['http://asset.localhost', 'http://ipc.localhost']);
  });

  test('no devCsp is committed; the launcher writes it from the resolved origin', () => {
    // A committed `devCsp` would be a second place an origin could be set, and it
    // is merged *before* the launcher's value, so a stale one would be silently
    // overridden rather than loudly wrong. One authority is the whole point.
    expect(config().app?.security?.devCsp).toBeUndefined();
  });
});

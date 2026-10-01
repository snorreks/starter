// apps/frontend/client/scripts/build_tauri.test.ts
//
// Native build orchestration, without building anything.
//
// `resolveInvocation` is pure, so the decision table — which target, which mode,
// which environment, and whether this host can do it at all — is testable without
// cargo, Xcode or an Android SDK.
//
// The cases that matter:
//
//   * the native-build flag is set for **every** native target, so an Android or
//     iOS build cannot ship the browser Tauri stub. The flag used to be named
//     `TAURI_DESKTOP_BUILD`, which reads as desktop-only.
//   * `tauri dev` refuses when PORT disagrees with `tauri.conf.json`'s devUrl,
//     instead of opening a window on nothing.
//   * a host that cannot build the target says which prerequisite is missing.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLIENT_DEV_PORT, expectedTauriDevUrl } from '../dev_ports.ts';
import {
  hostBlocker,
  parseTarget,
  readConfiguredDevUrl,
  resolveInvocation,
} from './build_tauri.ts';

const configuredDevUrl = (): string | null => readConfiguredDevUrl();

/** A host that can build anything, so the port rules are what is under test. */
const capableHost = (): null => null;

describe('dev ports', () => {
  test('tauri.conf.json devUrl agrees with the Vite dev port', () => {
    // The drift this replaces: vite defaulted to 5273, tauri.conf.json hard-coded
    // 5173, and `tauri dev` opened a window on a port nothing was listening on.
    const url = configuredDevUrl();
    expect(url).not.toBeNull();
    expect(new URL(url as string).port).toBe(String(CLIENT_DEV_PORT));
    expect(expectedTauriDevUrl()).toBe(url);
  });
});

describe('parseTarget', () => {
  test.each([
    [['--android'], 'android'],
    [['--ios'], 'ios'],
    [['--desktop'], 'desktop'],
  ])('names an explicit target: %p -> %s', (args, expected) => {
    expect(parseTarget(args as string[])).toBe(expected);
  });

  test.each([
    [['--target', 'android'], 'android'],
    [['--target', 'ios'], 'ios'],
  ])('names a --target platform: %p -> %s', (args, expected) => {
    expect(parseTarget(args as string[])).toBe(expected);
  });

  test('returns null when no target flag is given', () => {
    // `null` means "not specified", which is different from "desktop": it lets
    // `resolveInvocation` apply the default without this function claiming the
    // caller asked for desktop.
    expect(parseTarget([])).toBeNull();
    expect(parseTarget(['--debug'])).toBeNull();
    expect(resolveInvocation('release', [], { blocker: capableHost }).target).toBe('desktop');
  });
});

describe('resolveInvocation: the native-build flag', () => {
  test.each([
    ['desktop' as const, []],
    ['android' as const, ['--android']],
    ['ios' as const, ['--ios']],
  ])('%s build sets TAURI_NATIVE_BUILD', (target, args) => {
    const invocation = resolveInvocation('release', args, { blocker: capableHost });

    expect(invocation.target).toBe(target);
    // The load-bearing assertion: this is what stops a mobile build from being
    // stubbed. The flag name says native, not desktop, on purpose.
    expect(invocation.env.TAURI_NATIVE_BUILD).toBe('true');
    // The old name still set, so an existing invocation keeps working.
    expect(invocation.env.TAURI_DESKTOP_BUILD).toBe('true');
  });

  test('the tauri subcommand carries the target flag', () => {
    // `blocker` and `devUrl` are both injected so these assert the argument shape
    // and nothing else: the host check would otherwise ask this machine about
    // cargo, and `devUrl` would otherwise be read from the real tauri.conf.json —
    // so a `tauri dev` assertion would depend on a file that has nothing to do
    // with the argv.
    expect(
      resolveInvocation('release', ['--android'], { blocker: capableHost, devUrl: null }).tauriArgs,
    ).toEqual(['build', '--android']);
    expect(resolveInvocation('release', [], { blocker: capableHost, devUrl: null }).tauriArgs).toEqual([
      'build',
    ]);
    expect(resolveInvocation('dev', ['--ios'], { blocker: capableHost, devUrl: null }).tauriArgs).toEqual(
      ['dev', '--ios'],
    );
  });

  test('unknown passthrough flags reach tauri', () => {
    expect(
      resolveInvocation('release', ['--debug', '--bundles', 'deb'], {
        blocker: capableHost,
        devUrl: null,
      }).tauriArgs,
    ).toEqual(['build', '--debug', '--bundles', 'deb']);
  });

  test('a --target platform reaches tauri once and names the target here too', () => {
    // The spelling the documentation uses. It has to survive to tauri intact *and*
    // be understood here, because the host check is asked about the target: a
    // launcher that passed `--target android` through but did not read it would
    // check for cargo and say nothing about the SDK.
    const invocation = resolveInvocation('release', ['--target', 'android'], {
      blocker: capableHost,
      devUrl: null,
    });

    expect(invocation.target).toBe('android');
    expect(invocation.tauriArgs).toEqual(['build', '--target', 'android']);
    expect(invocation.blocked).toBeNull();
  });
});

describe('resolveInvocation: the dev-server port', () => {
  test('a matching PORT resolves cleanly', () => {
    const invocation = resolveInvocation('dev', [], {
      clientPort: CLIENT_DEV_PORT,
      blocker: capableHost,
    });
    expect(invocation.blocked).toBeNull();
    expect(invocation.env.PORT).toBe(String(CLIENT_DEV_PORT));
  });

  test('a PORT that disagrees with tauri.conf.json is refused with both options', () => {
    const invocation = resolveInvocation('dev', [], { clientPort: 5999, blocker: capableHost });

    expect(invocation.blocked).not.toBeNull();
    // The message has to name the mismatch *and* say what to do, because the
    // operator's next move differs: unset PORT, or pass --config.
    expect(invocation.blocked).toContain('PORT=5999');
    expect(invocation.blocked).toContain('--config');
  });

  test('an unreadable devUrl is reported rather than assumed', () => {
    const invocation = resolveInvocation('dev', [], { blocker: capableHost, devUrl: null });
    expect(invocation.blocked).toContain('Could not read build.devUrl');
  });

  test('a release build does not check devUrl', () => {
    // `tauri build` compiles frontendDist and never reads devUrl, so a port
    // mismatch there is not a problem to report.
    expect(
      resolveInvocation('release', [], { clientPort: 5999, blocker: capableHost }).blocked,
    ).toBeNull();
  });

  test('a host that cannot build the target is blocked before the port check', () => {
    // The prerequisite is the more useful message: naming a port mismatch to
    // someone with no cargo installed is a distraction.
    const invocation = resolveInvocation('dev', [], {
      clientPort: 5999,
      blocker: () => 'cargo is not on PATH.',
    });
    expect(invocation.blocked).toBe('cargo is not on PATH.');
  });
});

describe('hostBlocker', () => {
  test('ios requires macOS', () => {
    const blocked = hostBlocker('ios');
    if (process.platform === 'darwin') {
      expect(blocked === null || blocked.includes('Xcode')).toBe(true);
    } else {
      expect(blocked).toContain('macOS');
    }
  });

  test('android names the missing SDK', () => {
    const saved = {
      ANDROID_HOME: process.env.ANDROID_HOME,
      ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT,
    };
    delete process.env.ANDROID_HOME;
    delete process.env.ANDROID_SDK_ROOT;
    try {
      expect(hostBlocker('android')).toContain('ANDROID_HOME');
    } finally {
      if (saved.ANDROID_HOME !== undefined) {
        process.env.ANDROID_HOME = saved.ANDROID_HOME;
      }
      if (saved.ANDROID_SDK_ROOT !== undefined) {
        process.env.ANDROID_SDK_ROOT = saved.ANDROID_SDK_ROOT;
      }
    }
  });

  test('android names a missing NDK even when the SDK is there', () => {
    // `null` claims this host can build the target, so the NDK is part of that
    // claim: an SDK root without one fails later as a linker error inside Gradle.
    // A fixture directory rather than the machine's real SDK, so the assertion is
    // about this rule and not about what happens to be installed.
    const sdk = mkdtempSync(join(tmpdir(), 'android-sdk-'));
    const saved = {
      ANDROID_HOME: process.env.ANDROID_HOME,
      ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT,
      ANDROID_NDK_HOME: process.env.ANDROID_NDK_HOME,
      NDK_HOME: process.env.NDK_HOME,
    };
    process.env.ANDROID_HOME = sdk;
    delete process.env.ANDROID_SDK_ROOT;
    delete process.env.ANDROID_NDK_HOME;
    delete process.env.NDK_HOME;

    try {
      const blocked = hostBlocker('android');
      // macOS can take the NDK from Homebrew rather than the SDK, so there the
      // SDK alone is enough.
      expect(blocked === null || blocked.includes('NDK')).toBe(true);

      if (blocked !== null && process.platform !== 'darwin') {
        expect(blocked).toContain('NDK');
        expect(blocked).toContain('ANDROID_NDK_HOME');
      }

      // With an NDK installed the target is no longer blocked, which is what makes
      // the previous assertion a rule about the NDK rather than about the fixture.
      mkdirSync(join(sdk, 'ndk', '27.0.12077973', 'toolchains'), { recursive: true });
      expect(hostBlocker('android')).toBeNull();
    } finally {
      rmSync(sdk, { recursive: true, force: true });
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  test('desktop names cargo when it is absent', () => {
    const blocked = hostBlocker('desktop');
    // Either cargo is installed and there is no blocker, or the message says how
    // to get it. Never a generic failure.
    expect(blocked === null || blocked.includes('cargo')).toBe(true);
  });
});

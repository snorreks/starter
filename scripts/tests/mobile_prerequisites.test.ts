// scripts/tests/mobile_prerequisites.test.ts
//
// The Android prerequisites, driven with a fake environment and a real
// temporary directory tree.
//
// These checks exist because the answer changes in ways nobody can see. A doctor
// that reports "the NDK is fine" for an SDK carrying r22 produces a build that
// fails several minutes later inside a linker, naming a symbol rather than the
// SDK; a doctor that trusts an empty `NDK_HOME` reports nothing at all while the
// operator believes they configured one. Both are silent, and neither is visible
// on the machine where the assertion should have caught it.
//
// No SDK, no JDK and no `adb` are needed: every probe here is either a
// filesystem path under a temporary directory or an injected environment.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  platformPackageApiLevel,
  REQUIRED_ANDROID_API_LEVEL,
  REQUIRED_ANDROID_PLATFORM_PACKAGE,
  REQUIRED_NDK_VERSION,
} from '../src/native/mobile.ts';
import {
  androidNdkCheck,
  androidPlatformCheck,
  androidSdkCheck,
  androidSdkRoot,
} from '../src/native/mobile_prerequisites.ts';

const scratch = mkdtempSync(join(tmpdir(), 'starter-android-doctor-'));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** A minimal SDK layout: `platforms/android-37` and zero or more NDK versions. */
const sdk = (ndkVersions: readonly string[], platforms: readonly string[] = []): string => {
  const root = join(
    scratch,
    `sdk-${ndkVersions.join('-')}-${platforms.join('-')}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(root, 'ndk'), { recursive: true });
  for (const version of ndkVersions) {
    mkdirSync(join(root, 'ndk', version), { recursive: true });
    writeFileSync(join(root, 'ndk', version, 'source.properties'), 'Pkg.Revision = 0.0.0');
  }
  mkdirSync(join(root, 'platforms'), { recursive: true });
  for (const platform of platforms) {
    mkdirSync(join(root, 'platforms', platform), { recursive: true });
  }
  return root;
};

describe('which SDK directory is read', () => {
  test('ANDROID_HOME wins, and says so', () => {
    const root = sdk([]);
    expect(androidSdkRoot({ ANDROID_HOME: root, ANDROID_SDK_ROOT: '/nowhere' })).toBe(root);
    expect(androidSdkCheck({ ANDROID_HOME: root }).detail).not.toContain('ANDROID_SDK_ROOT');
  });

  test('ANDROID_SDK_ROOT is the fallback, and is named in the detail', () => {
    // The pinned CLI prefers ANDROID_HOME and treats ANDROID_SDK_ROOT as
    // deprecated. Reporting "the Android SDK" without saying which variable it
    // read leaves somebody debugging the wrong one.
    const root = sdk([]);
    expect(androidSdkRoot({ ANDROID_SDK_ROOT: root })).toBe(root);
    expect(androidSdkCheck({ ANDROID_SDK_ROOT: root }).detail).toContain('ANDROID_SDK_ROOT');
  });

  test('neither variable is a named absence, not an empty SDK', () => {
    const check = androidSdkCheck({});
    expect(check.ok).toBe(false);
    expect(check.remedy).toContain('ANDROID_HOME');
  });

  test('a path that does not exist is refused rather than reported as present', () => {
    const check = androidSdkCheck({ ANDROID_HOME: join(scratch, 'not-here') });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('does not exist');
  });
});

describe('the compileSdk platform, which is an API level and not a package name', () => {
  test('the package name is a real one, and there is no bare android-37 to ask for', () => {
    // Read out of dl.google.com/android/repository/repository2-3.xml: the 37.x
    // platforms are `android-37.0`, `37.1`, `37.2` and three betas. Asking
    // `sdkmanager` for `platforms;android-37` returns "Failed to find package",
    // which is how CI found this.
    expect(REQUIRED_ANDROID_PLATFORM_PACKAGE).toBe('platforms;android-37.2');
    expect(REQUIRED_ANDROID_PLATFORM_PACKAGE).not.toBe('platforms;android-37');
    expect(platformPackageApiLevel(REQUIRED_ANDROID_PLATFORM_PACKAGE)).toBe(
      REQUIRED_ANDROID_API_LEVEL,
    );
  });

  test('an SDK carrying android-37.2 satisfies API 37', () => {
    // The archive unpacks into platforms/android-37.2/, so there is no
    // `android-37` directory for a name-equality check to find.
    const root = sdk([], ['android-37.2']);
    const check = androidPlatformCheck({ ANDROID_HOME: root });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('android-37.2');
  });

  test('the highest installed minor is the one reported', () => {
    const root = sdk([], ['android-37.0', 'android-37.10', 'android-37.2']);
    const check = androidPlatformCheck({ ANDROID_HOME: root });
    // Numeric, not lexicographic: `37.10` must beat `37.2`.
    expect(check.detail).toContain('android-37.10');
  });

  test('a different API level does not satisfy it', () => {
    const root = sdk([], ['android-33', 'android-34']);
    const check = androidPlatformCheck({ ANDROID_HOME: root });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('android-33');
    expect(check.remedy).toContain(REQUIRED_ANDROID_PLATFORM_PACKAGE);
    expect(check.remedy).not.toContain('"platforms;android-37"');
  });

  test('a preview directory that is not a platform is ignored', () => {
    const root = sdk([], ['android-canary', 'android-Baklava']);
    expect(androidPlatformCheck({ ANDROID_HOME: root }).ok).toBe(false);
  });
});

describe('the NDK, which has three ways to be wrong', () => {
  test(`NDK_HOME pointing at ${REQUIRED_NDK_VERSION} is accepted and named`, () => {
    const root = sdk([REQUIRED_NDK_VERSION]);
    const check = androidNdkCheck({
      ANDROID_HOME: root,
      NDK_HOME: join(root, 'ndk', REQUIRED_NDK_VERSION),
    });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('NDK_HOME');
  });

  test('an empty NDK_HOME falls through to ANDROID_NDK_HOME, and says which one it read', () => {
    // `??` alone accepts `''` as a set variable, so the operator's empty CI
    // variable silently became "no NDK anywhere" with no name in the message.
    const root = sdk([REQUIRED_NDK_VERSION]);
    const check = androidNdkCheck({
      ANDROID_HOME: root,
      NDK_HOME: '   ',
      ANDROID_NDK_HOME: join(root, 'ndk', REQUIRED_NDK_VERSION),
    });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain('ANDROID_NDK_HOME');
  });

  test('an NDK_HOME pointing nowhere is refused with the variable named', () => {
    const check = androidNdkCheck({ NDK_HOME: join(scratch, 'no-such-ndk') });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('NDK_HOME=');
  });

  test(`an SDK carrying only an older NDK does not satisfy ${REQUIRED_NDK_VERSION}`, () => {
    // The failure this prevents: `readdirSync().sort()` is lexicographic, so the
    // "newest" directory of an SDK carrying both 9.0.0 and 29.x can be read as
    // the older one — and an SDK carrying only r22 is accepted outright.
    const root = sdk(['22.3.7177770']);
    const check = androidNdkCheck({ ANDROID_HOME: root });
    expect(check.ok).toBe(false);
    expect(check.severity).toBe('required');
    expect(check.detail).toContain(REQUIRED_NDK_VERSION);
    expect(check.remedy).toContain(`sdkmanager "ndk;${REQUIRED_NDK_VERSION}"`);
  });

  test(`an SDK carrying an older NDK and ${REQUIRED_NDK_VERSION} is accepted`, () => {
    const root = sdk(['9.0.0', '22.3.7177770', REQUIRED_NDK_VERSION]);
    const check = androidNdkCheck({ ANDROID_HOME: root });
    expect(check.ok).toBe(true);
    expect(check.detail).toContain(REQUIRED_NDK_VERSION);
  });

  test('an SDK with no ndk directory at all names both variables', () => {
    const root = join(scratch, 'sdk-empty');
    mkdirSync(join(root, 'ndk'), { recursive: true });
    const check = androidNdkCheck({ ANDROID_HOME: root });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('NDK_HOME');
    expect(check.detail).toContain('ANDROID_NDK_HOME');
  });
});

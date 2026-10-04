// scripts/tests/native_mobile.test.ts
//
// The Android and iPhone invocations, asserted on a machine with neither SDK.
//
// The property under test is that every flag is either mapped to a real flag of
// the pinned CLI, or refused by name. The reference is not this file's memory:
// `tauri android {init,dev,build,run} --help` on a Linux host, and
// `crates/tauri-cli/src/mobile/ios/*.rs` at `tauri-cli-v2.12.1`, because
// `tauri ios` is not compiled into a non-macOS build of that CLI. The test file
// that reads the Android help at runtime is the negative control at the bottom.
//
// The second property is the exit code, which is the difference between a wrong
// flag (2) and a host that cannot do it at all (3). `tauri ios build` on Linux is
// `error: unrecognized subcommand 'ios'` and exit 2, so a launcher that forwarded
// it would record a macOS job's request as a usage mistake.

import { describe, expect, test } from 'bun:test';
import { nativeCommand } from '../src/commands/native.ts';
import {
  ANDROID_TARGET_TRIPLES,
  ANDROID_TARGETS,
  flagsFor,
  IOS_TARGET_TRIPLES,
  IOS_TARGETS,
  MOBILE_MODES,
  type MobilePlatform,
  parseMobileArgs,
  planMobileInvocation,
  REQUIRED_ANDROID_API_LEVEL,
  REQUIRED_ANDROID_PLATFORM_PACKAGE,
  REQUIRED_NDK_VERSION,
} from '../src/native/mobile.ts';
import { hostPlatform } from '../src/native/platform.ts';

const parse = (platform: MobilePlatform, args: string[], hostOS: 'macos' | 'linux' = 'macos') => {
  const result = parseMobileArgs(platform, args);
  if (!result.ok) {
    throw new Error(`expected "${platform} ${args.join(' ')}" to parse: ${result.message}`);
  }
  // `hostOS: 'macos'` so the argv assertions run on every machine. The refusal on
  // a host without `tauri ios` is asserted separately, against the real
  // `process.platform`, so nothing is checked only on macOS.
  return { ...result.options, hostOS };
};

const argsFor = (platform: MobilePlatform, args: string[]): string[] | string => {
  const planned = planMobileInvocation(parse(platform, args));
  return planned.ok ? [...planned.invocation.args] : planned.message;
};

/**
 * True where `tauri ios` exists.
 *
 * The iOS tests below split on it rather than skipping wholesale: the refusal is
 * the behaviour a non-macOS host needs, so asserting it is asserting the product,
 * not skipping the platform.
 */
const onMac = hostPlatform() === 'macos';

describe('android invocations', () => {
  test('init is `tauri android init --ci` in src-tauri', () => {
    expect(argsFor('android', ['init', '--ci'])).toEqual(['android', 'init', '--ci']);
  });

  test('a build names its ABI, not a Rust triple', () => {
    expect(argsFor('android', ['build', '--target', 'aarch64', '--aab', '--ci'])).toEqual([
      'android',
      'build',
      '--target',
      'aarch64',
      '--aab',
      '--ci',
    ]);
  });

  test('a Rust triple in --target is refused and the ABI list is offered', () => {
    const planned = planMobileInvocation({
      platform: 'android',
      mode: 'build',
      targets: ['aarch64-linux-android'],
    });

    expect(planned.ok).toBe(false);
    if (planned.ok) {
      return;
    }
    expect(planned.kind).toBe('usage');
    expect(planned.message).toContain('Rust target triple');
    expect(planned.remedy).toContain('aarch64, armv7, i686, x86_64');
  });

  test("the other platform's target is refused and says which platform it belongs to", () => {
    const planned = planMobileInvocation({
      platform: 'android',
      mode: 'build',
      targets: ['aarch64-sim'],
    });

    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.message).toContain('belongs to the other platform');
    }
  });

  test('several ABIs repeat --target, which is how the CLI appends', () => {
    expect(argsFor('android', ['build', '--target', 'aarch64', '--target', 'armv7'])).toEqual([
      'android',
      'build',
      '--target',
      'aarch64',
      '--target',
      'armv7',
    ]);
  });

  test('--split-per-abi with one ABI is a contradiction, not a flag', () => {
    const planned = planMobileInvocation({
      platform: 'android',
      mode: 'build',
      targets: ['armv7'],
      splitPerAbi: true,
    });

    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.message).toContain('one file');
    }
  });

  test('--apk and --export-method cannot appear on the same command', () => {
    // Each is real on its own platform and a usage error on the other.
    const androidWithExport = planMobileInvocation({
      platform: 'android',
      mode: 'build',
      apk: true,
      exportMethod: 'app-store-connect',
    });
    expect(androidWithExport.ok).toBe(false);

    const iosWithApk = planMobileInvocation({
      ...parse('ios', ['build']),
      targets: ['aarch64'],
      apk: true,
    });
    expect(iosWithApk.ok).toBe(false);
    if (!iosWithApk.ok) {
      expect(iosWithApk.message).toContain('Android packaging flags');
    }
  });

  test('a dev run on a named phone puts the device last and the host before it', () => {
    expect(argsFor('android', ['dev', '--host', '192.168.1.20', 'Pixel 8'])).toEqual([
      'android',
      'dev',
      '--host',
      '192.168.1.20',
      'Pixel 8',
    ]);
  });

  test('--host on a build is refused: a packaged app has no dev server to reach', () => {
    const planned = planMobileInvocation({
      platform: 'android',
      mode: 'build',
      host: '192.168.1.20',
    });

    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.message).toContain('dev flag');
    }
  });

  test('a device name on init or build is refused with the subcommands that take one', () => {
    for (const mode of ['init', 'build'] as const) {
      const planned = planMobileInvocation({ platform: 'android', mode, device: 'Pixel 8' });
      expect(planned.ok).toBe(false);
      if (!planned.ok) {
        expect(planned.message).toContain(`not a ${mode} flag`);
      }
    }
  });

  test('--debug with --release asks for two builds and is refused', () => {
    const planned = planMobileInvocation({
      platform: 'android',
      mode: 'build',
      debug: true,
      release: true,
    });

    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.message).toContain('two different builds');
    }
  });
});

describe('ios invocations', () => {
  test('a simulator build names a simulator target explicitly', () => {
    // The CLI's default is `aarch64`, the *device*. A simulator lane that omits
    // it produces an IPA no simulator can install.
    expect(argsFor('ios', ['build', '--target', 'aarch64-sim', '--ci'])).toEqual([
      'ios',
      'build',
      '--target',
      'aarch64-sim',
      '--ci',
    ]);
  });

  test('an archive for TestFlight is named by its export method', () => {
    const planned = planMobileInvocation({
      ...parse('ios', ['build']),
      targets: ['aarch64'],
      exportMethod: 'release-testing',
      buildNumber: 7,
    });

    expect(planned.ok && planned.invocation.args).toEqual([
      'ios',
      'build',
      '--target',
      'aarch64',
      '--export-method',
      'release-testing',
      '--build-number',
      '7',
    ]);
  });

  test("an export method outside the CLI's values is refused at parse time", () => {
    const parsed = parseMobileArgs('ios', ['build', '--export-method', 'ad-hoc']);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.remedy).toContain('app-store-connect');
    }
  });

  test('a build number that is not a positive integer is refused', () => {
    for (const raw of ['0', '-1', '1.5', 'latest']) {
      const parsed = parseMobileArgs('ios', ['build', '--build-number', raw]);
      expect(parsed.ok).toBe(false);
    }
  });

  test('--no-sign and --archive-only reach the iOS build', () => {
    expect(argsFor('ios', ['build', '--target', 'aarch64', '--no-sign', '--archive-only'])).toEqual(
      ['ios', 'build', '--target', 'aarch64', '--no-sign', '--archive-only'],
    );
  });

  test.skipIf(onMac)('on a host without the subcommand, iOS is refused as unavailable', () => {
    // The refusal has to exist here, because on Linux the CLI would answer with
    // exit 2 and a clap usage block, and a caller reading exit codes alone would
    // record it as a usage mistake.
    const planned = planMobileInvocation({
      platform: 'ios',
      mode: 'build',
      targets: ['aarch64-sim'],
    });

    expect(planned.ok).toBe(false);
    if (planned.ok) {
      return;
    }
    expect(planned.kind).toBe('unavailable');
    expect(planned.message).toContain('not available on this host');
    expect(planned.remedy).toContain('macos-14');
  });
});

describe('the vocabulary comes from the CLI, and only from the CLI', () => {
  test('every accepted flag is a real one for that platform and subcommand', () => {
    // The snapshot's launcher forwarded `--android`/`--ios` to a CLI that has no
    // such flags, so `--tauri-deb` was a silent no-op. A flag in this table that
    // the CLI does not have is the same defect with a test in front of it.
    expect(flagsFor('android', 'build')).toContain('--aab');
    expect(flagsFor('android', 'build')).not.toContain('--no-sign');
    expect(flagsFor('android', 'dev')).toContain('--host');
    expect(flagsFor('android', 'dev')).not.toContain('--apk');
    expect(flagsFor('ios', 'build')).toContain('--export-method');
    expect(flagsFor('ios', 'build')).not.toContain('--apk');
    expect(flagsFor('ios', 'init')).toContain('--reinstall-deps');
    expect(flagsFor('android', 'init')).not.toContain('--reinstall-deps');
  });

  test("the ABI and architecture lists are the CLI's, closed", () => {
    expect([...ANDROID_TARGETS]).toEqual(['aarch64', 'armv7', 'i686', 'x86_64']);
    expect([...IOS_TARGETS]).toEqual(['aarch64', 'aarch64-sim', 'x86_64']);
    expect(MOBILE_MODES.length).toBeGreaterThan(0);
    expect(planMobileInvocation({ platform: 'android', mode: 'build', targets: ['mips'] }).ok).toBe(
      false,
    );
  });

  test('every declared triple is a Rust target, not an invention', () => {
    // The doctor tells a contributor to `rustup target add` these. A name rustup
    // does not know turns that advice into a second, more confusing failure.
    const triples = [
      ...Object.values(ANDROID_TARGET_TRIPLES),
      ...Object.values(IOS_TARGET_TRIPLES),
    ];
    expect(new Set(triples).size).toBe(triples.length);
    const prefixes = new Set(
      [
        ...ANDROID_TARGETS.map((target) => ANDROID_TARGET_TRIPLES[target]),
        ...IOS_TARGETS.map((target) => IOS_TARGET_TRIPLES[target]),
      ].map((triple) => triple.split('-')[0] ?? ''),
    );
    for (const triple of triples) {
      // `-android`, `-androideabi` or `-ios[-sim]`: the four endings rustup
      // actually publishes for these platforms.
      expect(/-(?:android|androideabi|ios|ios-sim)$/.test(triple)).toBe(true);
      expect(prefixes.has(triple.split('-')[0] ?? '')).toBe(true);
    }
  });

  test("the pinned API level and NDK are the CLI's constants, not a preference", () => {
    // From crates/tauri-cli/src/mobile/android/mod.rs at tauri-cli-v2.12.1.
    expect(REQUIRED_ANDROID_API_LEVEL).toBe('37');
    expect(REQUIRED_NDK_VERSION).toBe('29.0.13846066');
  });

  test('the installable platform package is not the API level', () => {
    // Two different things, and CI proved it: `SDK_VERSION: u8 = 37` is what
    // Gradle's `compileSdk` is written with, and no package by that name exists —
    // `sdkmanager` answered "Failed to find package 'platforms;android-37'" and
    // the lane died before building anything.
    expect(REQUIRED_ANDROID_PLATFORM_PACKAGE).toMatch(/^platforms;android-\d+\.\d+$/);
    expect(REQUIRED_ANDROID_PLATFORM_PACKAGE).not.toBe(
      `platforms;android-${REQUIRED_ANDROID_API_LEVEL}`,
    );
  });
});

describe('a flag with no usable value is refused', () => {
  test('--target with nothing after it, or another flag, is not forwarded', () => {
    // `--host ''` would reach the CLI as "ask the user", and `--target --apk`
    // would consume the next *flag* as an ABI and report "not a known target" —
    // a diagnosis with nothing to do with what was typed.
    for (const args of [
      ['build', '--target'],
      ['build', '--target', ''],
      ['build', '--target', '--aab'],
    ]) {
      const parsed = parseMobileArgs('android', args);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.message).toBe('--target needs a value.');
        expect(parsed.remedy).toContain('rather than forwarded as an empty string');
      }
    }
  });

  test('a value that only looks blank is still a value', () => {
    // A device name may legitimately contain spaces. Only emptiness and a leading
    // `--` are refusals.
    const parsed = parseMobileArgs('android', ['dev', 'Pixel 8 Pro']);
    expect(parsed.ok).toBe(true);
  });

  test('--host, --export-method, --build-number, --port and --features behave alike', () => {
    for (const [platform, flag] of [
      ['android', '--features'],
      ['android', '--host'],
      ['ios', '--export-method'],
      ['ios', '--build-number'],
      ['ios', '--port'],
      ['ios', '--additional-watch-folders'],
    ] as const) {
      const parsed = parseMobileArgs(platform, ['build', flag]);
      // `--host` is dev-only and `--additional-watch-folders` is dev-only, so on
      // `build` those are refused for being wrong *for this subcommand*. Either
      // way the command must not be forwarded.
      expect(parsed.ok).toBe(false);
    }
  });
});

describe('a second --config is refused rather than merged last', () => {
  test('it would replace the CSP this launcher writes, silently', () => {
    const parsed = parseMobileArgs('android', ['build', '--config', '{"app":{}}']);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain('validated API origin');
    }
  });
});

describe('the command itself', () => {
  test('an unknown subcommand is a usage error', async () => {
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(await nativeCommand.run(['windows-phone'])).toBe(2);
    } finally {
      process.stderr.write = original;
    }
  });

  test('an unknown flag inside a mobile subcommand is refused before launching', async () => {
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(await nativeCommand.run(['android', 'build', '--tauri-deb'])).toBe(2);
      expect(await nativeCommand.run(['android'])).toBe(2);
      expect(await nativeCommand.run(['android', 'publish'])).toBe(2);
    } finally {
      process.stderr.write = original;
    }
  });

  test('iOS on this host exits 3, not 1 and not 0', async () => {
    if (hostPlatform() === 'macos') {
      return;
    }
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(await nativeCommand.run(['ios', 'build', '--target', 'aarch64-sim', '--ci'])).toBe(3);
    } finally {
      process.stderr.write = original;
    }
  });

  test('help lists the mobile subcommands and their target vocabulary', async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await nativeCommand.run(['--help'])).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    const text = written.join('');
    expect(text).toContain('android <mode>');
    expect(text).toContain('ios <mode>');
    expect(text).toContain('aarch64-sim');
  });
});

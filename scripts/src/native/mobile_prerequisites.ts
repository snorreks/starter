// scripts/src/native/mobile_prerequisites.ts
//
// What this host must have before `native android …` or `native ios …` can run.
//
// Separate from `doctor.ts` because the answer is different in kind. The desktop
// doctor asks "can I compile and link a window on this machine"; the mobile
// question is "does this machine have the vendor's SDK, and is it the version the
// pinned CLI wants". Those are separate toolchains on separate runners, and a
// combined report that listed them together would have every contributor on Linux
// reading N/A lines for four things they will never install.
//
// Every check runs the tool and reads what it reports. `which java` proves a file
// exists; `java -version` proves it loads and that it is a JDK rather than a JRE —
// the difference that bites on a fresh runner image, where a JRE is present and
// Gradle fails four minutes later with a message about a compiler.
//
// Nothing here installs anything and nothing here prompts. The Tauri CLI will
// offer to download an SDK interactively; a CI lane that accepted that prompt
// would have a build that depends on a TTY, so `--ci` is the only spelling the
// workflow uses and the SDK is provisioned as a step with a named version.

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, Severity } from '../setup/doctor.ts';
import {
  ANDROID_TARGET_TRIPLES,
  type AndroidTarget,
  IOS_TARGET_TRIPLES,
  type IosTarget,
  REQUIRED_ANDROID_SDK,
  REQUIRED_NDK_VERSION,
} from './mobile.ts';
import { hostPlatform } from './platform.ts';

/**
 * The environment these checks read.
 *
 * An index signature rather than a fixed list, so `process.env` is assignable
 * without a cast: `ProcessEnv` is itself a string dictionary, and a narrower type
 * would have forced every caller through `as unknown as`. The names actually read
 * are `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `NDK_HOME`, `ANDROID_NDK_HOME`,
 * `JAVA_HOME` and `PATH`.
 */
export interface MobileEnvironment {
  readonly [name: string]: string | undefined;
}

const MAX_BYTES = 1_000_000;

/** Run a command, take its first line of output. Null means it did not run. */
const probe = (
  command: string,
  args: readonly string[] = ['--version'],
  env: NodeJS.ProcessEnv = process.env,
): string | null => {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    env,
    timeout: 30_000,
    maxBuffer: MAX_BYTES,
  });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  const first = (result.stdout ?? '') + (result.stderr ?? '');
  return first.split('\n')[0]?.trim() ?? '';
};

const ok = (name: string, detail: string, severity: Severity = 'required'): Check => ({
  name,
  severity,
  ok: true,
  detail,
});

const missing = (name: string, detail: string, remedy: string): Check => ({
  name,
  severity: 'required',
  ok: false,
  detail,
  remedy,
});

const absent = (name: string, detail: string, remedy: string): Check => ({
  name,
  severity: 'optional',
  ok: false,
  detail,
  remedy,
});

// ── Android ──────────────────────────────────────────────────────────────────

/**
 * Where the SDK is.
 *
 * `ANDROID_HOME` first, then `ANDROID_SDK_ROOT`. The pinned CLI prefers
 * `ANDROID_HOME` and only falls back, and it says `ANDROID_SDK_ROOT` is
 * deprecated — so this reports which one it found rather than "the Android SDK",
 * because "the Android SDK is set but the CLI ignores your variable" is a real
 * and confusing state.
 */
export const androidSdkRoot = (env: MobileEnvironment): string | undefined => {
  const home = env.ANDROID_HOME?.trim();
  if (home !== undefined && home.length > 0) {
    return home;
  }
  const legacy = env.ANDROID_SDK_ROOT?.trim();
  return legacy !== undefined && legacy.length > 0 ? legacy : undefined;
};

export const androidSdkCheck = (env: MobileEnvironment): Check => {
  const root = androidSdkRoot(env);
  if (root === undefined) {
    return missing(
      'android sdk',
      'ANDROID_HOME and ANDROID_SDK_ROOT are both unset',
      'Install the Android SDK (https://developer.android.com/studio) and export ' +
        'ANDROID_HOME. On CI, `android-actions/setup-android` writes it.',
    );
  }
  if (!existsSync(root)) {
    return missing(
      'android sdk',
      `ANDROID_HOME=${root} does not exist`,
      'Point ANDROID_HOME at a real SDK directory. A path that is not there fails later ' +
        'inside Gradle, naming a package rather than the variable.',
    );
  }
  return ok('android sdk', `${root}${env.ANDROID_HOME ? '' : ' (via ANDROID_SDK_ROOT)'}`);
};

/**
 * The installed platform and the one the pinned CLI compiles against.
 *
 * `compileSdk = 37` is a constant in the CLI's own source, not a preference. A
 * build against a different platform number produces an error naming a Gradle
 * property, and the fix is one `sdkmanager` line; saying which one is the point.
 */
export const androidPlatformCheck = (env: MobileEnvironment): Check => {
  const root = androidSdkRoot(env);
  if (root === undefined || !existsSync(root)) {
    return absent(
      `android platform ${REQUIRED_ANDROID_SDK}`,
      'no SDK to look in',
      'The pinned Tauri CLI compiles against android-37. `sdkmanager "platforms;android-37"`.',
    );
  }
  const platforms = join(root, 'platforms');
  let found: string[] = [];
  try {
    found = readdirSync(platforms).filter((entry) => /^android-\d+$/.test(entry));
  } catch {
    return absent(
      `android platform ${REQUIRED_ANDROID_SDK}`,
      'no platforms/ directory in the SDK',
      'The pinned Tauri CLI compiles against android-37. `sdkmanager "platforms;android-37"`.',
    );
  }
  const wanted = `android-${REQUIRED_ANDROID_SDK}`;
  return found.includes(wanted)
    ? ok(`android platform ${REQUIRED_ANDROID_SDK}`, wanted)
    : absent(
        `android platform ${REQUIRED_ANDROID_SDK}`,
        found.length === 0 ? 'none installed' : `installed: ${found.join(', ')}`,
        `The pinned Tauri CLI compiles against ${wanted}. ` +
          `\`sdkmanager "platforms;${wanted}"\`.`,
      );
};

/**
 * The NDK.
 *
 * `NDK_HOME` first, then the highest directory under `$ANDROID_HOME/ndk`, which
 * is what the CLI itself does — it sorts the installed versions and takes the
 * last. The version is compared, because an SDK carrying NDK r22 links nothing
 * this shell needs and says so as `undefined reference` from inside a linker.
 */
export const androidNdkCheck = (env: MobileEnvironment): Check => {
  const declared = env.NDK_HOME?.trim() ?? env.ANDROID_NDK_HOME?.trim();
  if (declared !== undefined && declared.length > 0) {
    if (!existsSync(declared)) {
      return missing(
        'android ndk',
        `NDK_HOME=${declared} does not exist`,
        'Point NDK_HOME at an installed NDK, or unset it and let the CLI find ' +
          `$ANDROID_HOME/ndk. The pinned CLI wants ${REQUIRED_NDK_VERSION}.`,
      );
    }
    return ok('android ndk', `${declared} (NDK_HOME)`);
  }

  const root = androidSdkRoot(env);
  if (root === undefined) {
    return absent(
      'android ndk',
      'no SDK to look in',
      `Install it with \`sdkmanager "ndk;${REQUIRED_NDK_VERSION}"\`, or set NDK_HOME.`,
    );
  }
  let versions: string[] = [];
  try {
    versions = readdirSync(join(root, 'ndk')).sort();
  } catch {
    versions = [];
  }
  if (versions.length === 0) {
    return missing(
      'android ndk',
      'no NDK under $ANDROID_HOME/ndk and NDK_HOME is unset',
      `\`sdkmanager "ndk;${REQUIRED_NDK_VERSION}"\`, or set NDK_HOME to an installed one.`,
    );
  }
  const newest = versions[versions.length - 1] ?? '';
  return ok('android ndk', `${newest} (${versions.join(', ')})`);
};

export const javaCheck = (env: MobileEnvironment): Check => {
  const home = env.JAVA_HOME?.trim();
  if (home !== undefined && home.length > 0) {
    const binary = join(home, 'bin', 'java');
    if (!existsSync(binary)) {
      return missing(
        'jdk',
        `JAVA_HOME=${home} has no bin/java`,
        'Point JAVA_HOME at a JDK 17 or newer. Gradle compiles the Android module, so a ' +
          'JRE is not enough even though `java -version` succeeds.',
      );
    }
  }
  const reported = probe('java', ['-version']);
  return reported === null
    ? missing(
        'jdk',
        'java is not on PATH and JAVA_HOME is unusable',
        "Install a JDK 17+ (Temurin, Zulu or the distribution's package) and set JAVA_HOME.",
      )
    : ok('jdk', reported);
};

/**
 * `adb`, reported as optional.
 *
 * Optional because the APK does not need it: `tauri android build` produces a
 * package with the SDK alone, and `adb` is what turns a package into something
 * installed on a device. A lane that only builds should not fail because it
 * cannot install; a lane that installs will fail when it gets there, naming the
 * missing tool.
 */
export const adbCheck = (): Check => {
  const reported = probe('adb', ['version']);
  return reported === null
    ? absent(
        'adb',
        'not on PATH',
        'Part of `platform-tools`. Needed to install and launch on a device or ' +
          'emulator; not needed to produce an APK.',
      )
    : ok('adb', reported);
};

/**
 * The rustup targets the ABIs need.
 *
 * The default lane builds `aarch64` only, because that is the ABI of every
 * current phone and the Apple-silicon-independent one; the other three are opt-in
 * and are listed when they are missing rather than reported as failures. A missing
 * target is a ten-second `rustup target add`, and the CLI runs it for you during
 * `init` unless `--skip-targets-install` is passed.
 */
export const androidTargetCheck = (
  env: MobileEnvironment,
  targets: readonly AndroidTarget[],
): Check => {
  const installed = rustupTargets(env);
  if (installed === null) {
    return absent(
      'rust android targets',
      'rustup is not on PATH',
      'Install the pinned toolchain from apps/frontend/native/src-tauri/rust-toolchain.toml. ' +
        '`tauri android init` installs the targets itself unless --skip-targets-install.',
    );
  }
  const missingTargets = targets
    .map((target) => ANDROID_TARGET_TRIPLES[target])
    .filter((triple) => !installed.includes(triple));
  const wanted = targets.map((target) => ANDROID_TARGET_TRIPLES[target]).join(', ');
  return missingTargets.length === 0
    ? ok('rust android targets', wanted)
    : absent(
        'rust android targets',
        `missing: ${missingTargets.join(', ')}`,
        `\`rustup target add ${missingTargets.join(' ')}\`.`,
      );
};

/**
 * The targets rustup reports, or null when rustup is not installed.
 *
 * One process, not two: the first line is enough to prove rustup ran, and then the
 * whole list is what is wanted, so this reads stdout once.
 */
export const rustupTargets = (env: MobileEnvironment): string[] | null => {
  const result = spawnSync('rustup', ['target', 'list', '--installed'], {
    encoding: 'utf8',
    env: { ...process.env, ...env } as NodeJS.ProcessEnv,
    timeout: 30_000,
    maxBuffer: MAX_BYTES,
  });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  return (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
};

// ── iOS ──────────────────────────────────────────────────────────────────────

export const xcodeCheck = (): Check => {
  if (hostPlatform() !== 'macos') {
    return missing(
      'xcode',
      `the iOS toolchain exists only on macOS; this host is ${hostPlatform()}`,
      'Run this on macOS with full Xcode selected (`xcode-select -s /Applications/Xcode.app`). ' +
        'The `ios` job in .github/workflows/native.yml runs on macos-14. A Linux build cannot ' +
        'be credited with an iOS build, however many Rust targets it has installed.',
    );
  }
  const reported = probe('xcodebuild', ['-version']);
  if (reported === null) {
    return missing(
      'xcode',
      'xcodebuild is not on PATH',
      'Install Xcode and select it: `xcode-select -s /Applications/Xcode.app`. ' +
        'The command line tools alone cannot build an app.',
    );
  }
  return ok('xcode', reported);
};

export const xcodeSelectCheck = (): Check => {
  const reported = probe('xcode-select', ['-p']);
  return reported === null
    ? missing(
        'xcode developer dir',
        'xcode-select -p failed',
        "`xcode-select -s /Applications/Xcode.app` (or your team's path).",
      )
    : ok('xcode developer dir', reported);
};

export const iosTargetCheck = (env: MobileEnvironment, targets: readonly IosTarget[]): Check => {
  const installed = rustupTargets(env);
  if (installed === null) {
    return absent(
      'rust ios targets',
      'rustup is not on PATH',
      'Install the pinned toolchain from apps/frontend/native/src-tauri/rust-toolchain.toml.',
    );
  }
  const wanted = targets.map((target) => IOS_TARGET_TRIPLES[target]);
  const missingTargets = wanted.filter((triple) => !installed.includes(triple));
  return missingTargets.length === 0
    ? ok('rust ios targets', wanted.join(', '))
    : absent(
        'rust ios targets',
        `missing: ${missingTargets.join(', ')}`,
        `\`rustup target add ${missingTargets.join(' ')}\``,
      );
};

export interface MobileReport {
  readonly platform: 'android' | 'ios';
  readonly checks: Check[];
  readonly ok: boolean;
  readonly missingRequired: string[];
  readonly unavailable: string[];
}

export const inspectAndroid = (
  env: MobileEnvironment = process.env,
  targets: readonly AndroidTarget[] = ['aarch64'],
): MobileReport =>
  buildReport('android', [
    androidSdkCheck(env),
    androidPlatformCheck(env),
    androidNdkCheck(env),
    javaCheck(env),
    adbCheck(),
    androidTargetCheck(env, targets),
  ]);

export const inspectIos = (
  env: MobileEnvironment = process.env,
  targets: readonly IosTarget[] = ['aarch64-sim'],
): MobileReport =>
  buildReport('ios', [xcodeCheck(), xcodeSelectCheck(), iosTargetCheck(env, targets)]);

const buildReport = (platform: 'android' | 'ios', checks: Check[]): MobileReport => ({
  platform,
  checks,
  ok: checks.every((check) => check.ok || check.severity === 'optional'),
  missingRequired: checks
    .filter((check) => check.severity === 'required' && !check.ok)
    .map((check) => check.name),
  unavailable: checks
    .filter((check) => check.severity === 'optional' && !check.ok)
    .map((check) => check.name),
});

export const renderMobileReport = (report: MobileReport): string => {
  const lines = report.checks.map((check) => {
    // `ok` / `N/A` / `MISS`, spelled out rather than nested: the three-way choice
    // is the whole point of this column and a nested ternary hides which one is
    // which at a glance.
    let mark = 'MISS';
    if (check.ok) {
      mark = 'ok  ';
    } else if (check.severity === 'optional') {
      mark = 'N/A ';
    }
    const detail = check.ok ? check.detail : `${check.detail} — ${check.remedy ?? 'no remedy'}`;
    return `  ${mark} ${check.name.padEnd(22)} ${detail}`;
  });
  const optional =
    report.unavailable.length === 0
      ? ''
      : ` Optional and unavailable here: ${report.unavailable.join(', ')}.`;
  const verdict = report.ok
    ? `Ready.${optional}`
    : `Not ready. Missing: ${report.missingRequired.join(', ')}.`;
  return [`Native ${report.platform} capability:`, ...lines, '', verdict].join('\n');
};

// scripts/src/native/mobile.ts
//
// The Android and iPhone subcommands, as a pure function of their arguments.
//
// Every flag below was read out of the pinned CLI rather than recalled. The
// Android half was read from `tauri android {init,dev,build,run} --help` on a
// Linux host, where those subcommands exist; the iOS half was read from
// `crates/tauri-cli/src/mobile/ios/*.rs` at the `tauri-cli-v2.12.1` tag, because
// `tauri ios` is `#[cfg(target_os = "macos")]` and this file is written on Linux.
// That asymmetry is a fact about the CLI, and it is the reason the vocabulary
// below is a table rather than a comment:
//
//   * `tauri ios` on a non-macOS host is `error: unrecognized subcommand 'ios'`.
//     Not a usage error this command can catch by convention — the subcommand is
//     not compiled into the binary. `bun run native ios build` therefore refuses
//     here, by exit code, before the CLI is reached at all.
//   * `tauri android build --target` takes an **ABI** (`aarch64`, `armv7`,
//     `i686`, `x86_64`), and `tauri ios build --target` takes an **architecture**
//     with a simulator variant (`aarch64`, `aarch64-sim`, `x86_64`). Neither is a
//     Rust target triple. `--target x86_64-linux-android` is a usage error, and so
//     is `--target aarch64-apple-ios`. A Rust triple goes to `cargo`, not here;
//     the triples are carried below because the doctor needs to check that the
//     corresponding rustup target is installed, and because a reader comparing
//     this file against `rustup target list` should not have to guess.
//
// What this refuses, and why refusing is the point:
//
//   * A flag the subcommand does not have. `tauri android dev --apk` is a usage
//     error; forwarding it would turn a typo into a confusing message from clap.
//   * Contradictory pairs: `--debug` with `--release`, `--apk` with a single
//     target and `--split-per-abi`, a target belonging to the other platform.
//   * iOS on anything but macOS, with the runner to use instead, exactly as the
//     desktop planner refuses another operating system.
//
// What it deliberately does not do is choose. No default device, no default
// target set, no "the emulator if one is attached". An artifact whose ABI was
// chosen by a default is an artifact nobody can reproduce from the log.

import { hostPlatform } from './platform.ts';

/** The native project's own directory, relative to the repository root. */
const NATIVE_DIR = 'apps/frontend/native';

/** Mobile platforms. Not Rust triples and not desktop platform names. */
export const MOBILE_PLATFORMS = ['android', 'ios'] as const;
export type MobilePlatform = (typeof MOBILE_PLATFORMS)[number];

/** The four subcommands the pinned CLI exposes on both platforms. */
export const MOBILE_MODES = ['init', 'dev', 'build', 'run'] as const;
export type MobileMode = (typeof MOBILE_MODES)[number];

/**
 * Android ABIs, and the Rust triple each one builds.
 *
 * `armv7` is the CLI's spelling of `armeabi-v7a`; the triple is
 * `armv7-linux-androideabi`. Both are confirmed against `rustup target list`, so
 * the doctor below can ask for a target that exists rather than one it invented.
 */
export const ANDROID_TARGETS = ['aarch64', 'armv7', 'i686', 'x86_64'] as const;
export type AndroidTarget = (typeof ANDROID_TARGETS)[number];

export const ANDROID_TARGET_TRIPLES: Readonly<Record<AndroidTarget, string>> = {
  aarch64: 'aarch64-linux-android',
  armv7: 'armv7-linux-androideabi',
  i686: 'i686-linux-android',
  x86_64: 'x86_64-linux-android',
};

/**
 * iOS architectures, and their Rust triples.
 *
 * `aarch64-sim` is the Apple Silicon simulator; `x86_64` is the Intel simulator;
 * `aarch64` alone is the device. The CLI's default is `aarch64`, which is the
 * *device* — so a simulator lane that forgets `--target` produces an IPA that no
 * simulator can install, and CI reports that as a build failure several minutes
 * later. The lanes in `.github/workflows/native.yml` therefore always state it.
 */
export const IOS_TARGETS = ['aarch64', 'aarch64-sim', 'x86_64'] as const;
export type IosTarget = (typeof IOS_TARGETS)[number];

export const IOS_TARGET_TRIPLES: Readonly<Record<IosTarget, string>> = {
  aarch64: 'aarch64-apple-ios',
  'aarch64-sim': 'aarch64-apple-ios-sim',
  x86_64: 'x86_64-apple-ios',
};

/** How an iOS archive is exported. Only the two store-facing ones matter here. */
export const IOS_EXPORT_METHODS = ['app-store-connect', 'release-testing', 'debugging'] as const;
export type IosExportMethod = (typeof IOS_EXPORT_METHODS)[number];

/** The NDK the pinned CLI installs when it has to. From its own source. */
export const REQUIRED_NDK_VERSION = '29.0.13846066';

/** The Android platform the pinned CLI compiles against. From its own source. */
export const REQUIRED_ANDROID_SDK = '37';

/**
 * The flags each subcommand accepts.
 *
 * A table rather than one global list, because "unknown flag" is only useful
 * advice if the answer names the flags that exist *for the command you ran*.
 * `tauri android build --no-sign` is an iOS flag; forwarding it produces clap's
 * `unexpected argument` with a usage block for a different command.
 */
const COMMON: readonly string[] = ['--features', '--config', '--verbose', '--open'];

const DEV_FLAGS: readonly string[] = [
  ...COMMON,
  '--exit-on-panic',
  '--release',
  '--no-dev-server-wait',
  '--no-watch',
  '--additional-watch-folders',
  '--force-ip-prompt',
  '--host',
  '--no-dev-server',
  '--port',
];

const RUN_FLAGS: readonly string[] = [
  ...COMMON,
  '--release',
  '--no-watch',
  '--additional-watch-folders',
  '--ignore-version-mismatches',
];

const FLAGS: Readonly<Record<MobilePlatform, Readonly<Record<MobileMode, readonly string[]>>>> = {
  android: {
    init: ['--ci', '--skip-targets-install', ...COMMON],
    dev: DEV_FLAGS,
    build: [
      '--debug',
      '--target',
      '--split-per-abi',
      '--apk',
      '--aab',
      '--ci',
      '--ignore-version-mismatches',
      ...COMMON,
    ],
    run: RUN_FLAGS,
  },
  ios: {
    init: ['--ci', '--reinstall-deps', '--skip-targets-install', ...COMMON],
    dev: DEV_FLAGS,
    build: [
      '--debug',
      '--target',
      '--build-number',
      '--ci',
      '--export-method',
      '--ignore-version-mismatches',
      '--no-sign',
      '--archive-only',
      ...COMMON,
    ],
    run: RUN_FLAGS,
  },
};

export interface MobileInvocation {
  /** The binary to run. Resolved through `resolveWorkspaceBin`, never `bunx`. */
  readonly bin: string;
  readonly args: readonly string[];
  /** Working directory. The CLI is always run from `src-tauri`. */
  readonly cwd: string;
}

export interface MobilePlanOptions {
  readonly platform: MobilePlatform;
  readonly mode: MobileMode;
  readonly targets?: readonly string[] | undefined;
  readonly device?: string | undefined;
  /** `--host`: the development machine's address, for a physical device. */
  readonly host?: string | undefined;
  readonly features?: readonly string[] | undefined;
  readonly apk?: boolean | undefined;
  readonly aab?: boolean | undefined;
  readonly splitPerAbi?: boolean | undefined;
  readonly debug?: boolean | undefined;
  readonly release?: boolean | undefined;
  readonly exportMethod?: IosExportMethod | undefined;
  readonly noSign?: boolean | undefined;
  readonly archiveOnly?: boolean | undefined;
  readonly buildNumber?: number | undefined;
  readonly open?: boolean | undefined;
  readonly ci?: boolean | undefined;
  readonly skipTargetsInstall?: boolean | undefined;
  readonly noWatch?: boolean | undefined;
  readonly noDevServerWait?: boolean | undefined;
  readonly exitOnPanic?: boolean | undefined;
  readonly additionalWatchFolders?: readonly string[] | undefined;
  readonly port?: number | undefined;
  readonly forceIpPrompt?: boolean | undefined;
  readonly reinstallDeps?: boolean | undefined;
  /**
   * The host operating system, for tests.
   *
   * Injected rather than read from `process.platform` so the iOS argv can be
   * asserted on a Linux machine — the refusal on a Linux machine is separately
   * asserted with the real `process.platform` below, so injecting here removes no
   * coverage; it moves the half that is about *flags* somewhere it can run. The
   * command never sets it.
   */
  readonly hostOS?: 'linux' | 'macos' | 'windows' | undefined;
}

export type MobilePlanResult =
  | { readonly ok: true; readonly invocation: MobileInvocation }
  | {
      readonly ok: false;
      readonly message: string;
      readonly remedy: string;
      readonly kind: 'usage' | 'unavailable';
    };

/** The flags that exist for one platform and mode, for a refusal message. */
export const flagsFor = (platform: MobilePlatform, mode: MobileMode): readonly string[] =>
  FLAGS[platform][mode];

const isAndroidTarget = (value: string): value is AndroidTarget =>
  (ANDROID_TARGETS as readonly string[]).includes(value);

const isIosTarget = (value: string): value is IosTarget =>
  (IOS_TARGETS as readonly string[]).includes(value);

const targetList = (platform: MobilePlatform): readonly string[] =>
  platform === 'android' ? ANDROID_TARGETS : IOS_TARGETS;

/** Every Rust triple either mobile platform builds, for the "you passed a triple" refusal. */
const ALL_TRIPLES: readonly string[] = [
  ...Object.values(ANDROID_TARGET_TRIPLES),
  ...Object.values(IOS_TARGET_TRIPLES),
];

/**
 * Does this look like a Rust target triple rather than an ABI?
 *
 * Shape first, with the membership list above only sharpening the message.
 * `armv7-linux-androideabi` has two dashes and a numeric prefix, so a
 * three-segment `[a-z0-9_]+` regex would miss it and answer "not an Android
 * target" — sending the reader to the ABI list instead of to the sentence that
 * says a triple belongs to cargo.
 */
const looksLikeTriple = (value: string): boolean =>
  ALL_TRIPLES.includes(value) || /^[a-z0-9]+(-[a-z0-9]+){2,}$/.test(value);

/**
 * Plan one mobile invocation, or explain the refusal.
 *
 * `kind` is what the caller turns into an exit code: a wrong or contradictory
 * flag is `usage` (2) and a capability this host lacks is `unavailable` (3).
 */
export const planMobileInvocation = (options: MobilePlanOptions): MobilePlanResult => {
  const { platform, mode, targets } = options;

  if (platform !== 'android' && platform !== 'ios') {
    return {
      ok: false,
      kind: 'usage',
      message: `"${platform}" is not a mobile platform.`,
      remedy: `Use one of: ${MOBILE_PLATFORMS.join(', ')}.`,
    };
  }
  if (!MOBILE_MODES.includes(mode)) {
    return {
      ok: false,
      kind: 'usage',
      message: `"${mode}" is not a mobile subcommand.`,
      remedy: `Use one of: ${MOBILE_MODES.join(', ')}.`,
    };
  }

  if (platform === 'ios' && (options.hostOS ?? hostPlatform()) !== 'macos') {
    // The refusal has to happen here rather than being left to the CLI, because
    // on this host the CLI has no `ios` subcommand to refuse with. Letting it run
    // produces `error: unrecognized subcommand 'ios'` and exit 2, which a caller
    // reading the exit code alone would record as a usage mistake on a macOS
    // job's behalf.
    return {
      ok: false,
      kind: 'unavailable',
      message: `The iOS commands are not available on this host (${hostPlatform()}).`,
      remedy:
        'The pinned Tauri CLI only compiles `tauri ios` into its macOS build, so the ' +
        'subcommand does not exist here at all. Run this on macOS with full Xcode, or ' +
        'let the ios job in .github/workflows/native.yml build it: it runs on macos-14.',
    };
  }

  // ── Contradictions, before any flag is emitted ────────────────────────────
  if (options.debug === true && options.release === true) {
    return {
      ok: false,
      kind: 'usage',
      message: '--debug and --release ask for two different builds.',
      remedy: 'Name one. A debug build is for a device you are testing; release is for a store.',
    };
  }
  if (options.splitPerAbi === true && targets !== undefined && targets.length === 1) {
    return {
      ok: false,
      kind: 'usage',
      message: '--split-per-abi with a single --target produces one file per ABI: one file.',
      remedy: 'Drop --split-per-abi, or name the ABIs you want split.',
    };
  }
  if (options.device !== undefined && (mode === 'init' || mode === 'build')) {
    return {
      ok: false,
      kind: 'usage',
      message: `--device is not a ${mode} flag.`,
      remedy:
        'A device is chosen by `dev` and `run`, the two subcommands that install or launch. ' +
        `\`tauri ${platform} ${mode}\` takes no device name.`,
    };
  }
  if (options.host !== undefined && mode !== 'dev') {
    return {
      ok: false,
      kind: 'usage',
      message: `--host is a dev flag, not a ${mode} flag.`,
      remedy:
        'A packaged build embeds its assets and reaches one configured API origin. The ' +
        'development host only matters while the device reloads from your machine.',
    };
  }

  // ── Targets ───────────────────────────────────────────────────────────────
  if (targets !== undefined && mode === 'init') {
    return {
      ok: false,
      kind: 'usage',
      message: '--target does nothing during init.',
      remedy: 'Drop it, or run the build that needs it.',
    };
  }
  for (const target of targets ?? []) {
    const known = platform === 'android' ? isAndroidTarget(target) : isIosTarget(target);
    if (known) {
      continue;
    }
    if (looksLikeTriple(target)) {
      return {
        ok: false,
        kind: 'usage',
        message: `--target "${target}" is a Rust target triple.`,
        remedy:
          `The ${platform} CLI takes ${platform === 'android' ? 'an ABI' : 'an architecture'}: ` +
          `${targetList(platform).join(', ')}. The triple for each is built by cargo from ` +
          'that name; the CLI never sees it.',
      };
    }
    const belongs = platform === 'android' ? isIosTarget(target) : isAndroidTarget(target);
    return {
      ok: false,
      kind: 'usage',
      message: belongs
        ? `--target "${target}" belongs to the other platform, not ${platform}.`
        : `--target "${target}" is not a ${platform} target.`,
      remedy: belongs
        ? `${platform} takes: ${targetList(platform).join(', ')}.`
        : `${platform} takes: ${targetList(platform).join(', ')}.`,
    };
  }
  if (platform === 'android' && targets !== undefined && targets.length > 1) {
    // `-t` is `ArgAction::Append` with `num_args(0..)`, so repeating it is the
    // documented spelling; a comma-joined value would be one unknown name.
    for (const target of targets) {
      if (!isAndroidTarget(target)) {
        return {
          ok: false,
          kind: 'usage',
          message: `--target "${target}" is not an Android ABI.`,
          remedy: `Android takes: ${ANDROID_TARGETS.join(', ')}.`,
        };
      }
    }
  }
  if (platform === 'ios' && (options.apk === true || options.aab === true)) {
    return {
      ok: false,
      kind: 'usage',
      message: '--apk and --aab are Android packaging flags.',
      remedy:
        'An iOS build produces an `.xcarchive` and, from it, an `.ipa`. Use ' +
        '`--archive-only` or `--export-method` instead.',
    };
  }
  if (platform === 'android' && options.exportMethod !== undefined) {
    return {
      ok: false,
      kind: 'usage',
      message: '--export-method is an iOS flag.',
      remedy:
        'An Android release bundle is an `.aab` produced by Gradle. Play delivery ' +
        'configuration belongs to the store listing, not to this command.',
    };
  }
  if (platform === 'android' && (options.noSign === true || options.archiveOnly === true)) {
    return {
      ok: false,
      kind: 'usage',
      message: `${options.noSign === true ? '--no-sign' : '--archive-only'} is an iOS flag.`,
      remedy:
        'Android signing is a Gradle/keystore concern configured by whoever releases; ' +
        'this command does not pass signing flags at all.',
    };
  }

  const known = new Set(flagsFor(platform, mode));
  const args: string[] = [platform, mode];

  const emit = (flag: string, value?: string): void => {
    args.push(flag);
    if (value !== undefined) {
      args.push(value);
    }
  };

  if (mode !== 'init' && options.features !== undefined && options.features.length > 0) {
    if (!known.has('--features')) {
      return unknownFlag('--features', platform, mode);
    }
    emit('--features', options.features.join(','));
  }
  if (targets !== undefined && targets.length > 0) {
    if (!known.has('--target')) {
      return unknownFlag('--target', platform, mode);
    }
    for (const target of targets) {
      emit('--target', target);
    }
  }
  if (options.device !== undefined) {
    // Not emitted here: the device name is a positional and goes last. See below.
  }
  if (options.host !== undefined) {
    emit('--host', options.host);
  }
  if (options.forceIpPrompt === true) {
    emit('--force-ip-prompt');
  }
  if (options.debug === true) {
    emit('--debug');
  }
  if (options.release === true) {
    emit('--release');
  }
  if (options.apk === true) {
    emit('--apk');
  }
  if (options.aab === true) {
    emit('--aab');
  }
  if (options.splitPerAbi === true) {
    emit('--split-per-abi');
  }
  if (options.exportMethod !== undefined) {
    emit('--export-method', options.exportMethod);
  }
  if (options.buildNumber !== undefined) {
    emit('--build-number', String(options.buildNumber));
  }
  if (options.noSign === true) {
    emit('--no-sign');
  }
  if (options.archiveOnly === true) {
    emit('--archive-only');
  }
  if (options.open === true) {
    emit('--open');
  }
  if (options.ci === true) {
    emit('--ci');
  }
  if (options.skipTargetsInstall === true) {
    emit('--skip-targets-install');
  }
  if (options.reinstallDeps === true) {
    emit('--reinstall-deps');
  }
  if (options.noWatch === true) {
    emit('--no-watch');
  }
  if (options.noDevServerWait === true) {
    emit('--no-dev-server-wait');
  }
  if (options.device !== undefined) {
    // A trailing positional. clap accepts it anywhere, and putting it last means
    // the argv a maintainer reads in CI ends with the thing being acted on.
    args.push(options.device);
  }
  if (options.exitOnPanic === true) {
    emit('--exit-on-panic');
  }
  for (const folder of options.additionalWatchFolders ?? []) {
    emit('--additional-watch-folders', folder);
  }
  if (options.port !== undefined) {
    emit('--port', String(options.port));
  }

  for (const arg of args.slice(2)) {
    if (arg.startsWith('--') && !known.has(arg)) {
      return unknownFlag(arg, platform, mode);
    }
  }

  return {
    ok: true,
    invocation: { bin: 'tauri', args, cwd: `${NATIVE_DIR}/src-tauri` },
  };
};

const unknownFlag = (
  flag: string,
  platform: MobilePlatform,
  mode: MobileMode,
): MobilePlanResult => ({
  ok: false,
  kind: 'usage',
  message: `\`tauri ${platform} ${mode}\` has no ${flag}.`,
  remedy: `It accepts: ${flagsFor(platform, mode).join(', ')}.`,
});

export interface MobileParseSuccess {
  readonly ok: true;
  readonly options: MobilePlanOptions;
}

export interface MobileParseFailure {
  readonly ok: false;
  readonly message: string;
  readonly remedy: string;
}

/** A missing value, as a distinct shape so `null` never means "the value was null". */

/**
 * Parse `native <platform> <mode> [flags]`.
 *
 * Refusing unknown flags here rather than forwarding them is inherited from the
 * desktop planner and for the same reason: a forwarded typo is a no-op at best
 * and somebody else's bug at worst.
 */
export const parseMobileArgs = (
  platform: MobilePlatform,
  args: readonly string[],
): MobileParseSuccess | MobileParseFailure => {
  if (!MOBILE_PLATFORMS.includes(platform)) {
    return {
      ok: false,
      message: `Unknown platform "${platform}".`,
      remedy: `Expected: ${MOBILE_PLATFORMS.join(', ')}.`,
    };
  }

  const [mode, ...rest] = args;
  if (mode === undefined) {
    return {
      ok: false,
      message: `\`native ${platform}\` needs a subcommand.`,
      remedy: `Expected one of: ${MOBILE_MODES.join(', ')}.`,
    };
  }
  if (!MOBILE_MODES.includes(mode as MobileMode)) {
    return {
      ok: false,
      message: `\`tauri ${platform}\` has no "${mode}".`,
      remedy: `Expected one of: ${MOBILE_MODES.join(', ')}.`,
    };
  }

  const parsed: {
    targets?: string[];
    device?: string;
    host?: string;
    features?: string[];
    forceIpPrompt?: boolean;
    apk?: boolean;
    aab?: boolean;
    splitPerAbi?: boolean;
    debug?: boolean;
    release?: boolean;
    exportMethod?: IosExportMethod;
    buildNumber?: number;
    noSign?: boolean;
    archiveOnly?: boolean;
    open?: boolean;
    ci?: boolean;
    skipTargetsInstall?: boolean;
    reinstallDeps?: boolean;
    noWatch?: boolean;
    noDevServerWait?: boolean;
    additionalWatchFolders?: string[];
    port?: number;
    exitOnPanic?: boolean;
  } = {};

  const known = new Set(flagsFor(platform, mode as MobileMode));

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] ?? '';
    if (!arg.startsWith('-')) {
      if (parsed.device !== undefined) {
        return {
          ok: false,
          message: `Unexpected argument "${arg}" after the device name.`,
          remedy: 'One device name at a time; `--` forwards arguments to the app itself.',
        };
      }
      parsed.device = arg;
      continue;
    }

    if (arg === '--config') {
      // Not a missing feature: a second configuration is merged *after* the one
      // this command builds, so it could replace the CSP whose connect-src is
      // the API origin, and nothing would fail. A caller that needs a different
      // API origin sets VITE_NATIVE_API_ORIGIN, which is validated.
      return {
        ok: false,
        message: '--config is supplied by this command, from the validated API origin.',
        remedy:
          'Set VITE_NATIVE_API_ORIGIN instead. A second --config is merged last and could ' +
          'replace the CSP this launcher writes, and that would fail silently.',
      };
    }

    if (!known.has(arg)) {
      return {
        ok: false,
        message: `\`tauri ${platform} ${mode}\` has no ${arg}.`,
        remedy: `It accepts: ${flagsFor(platform, mode as MobileMode).join(', ')}.`,
      };
    }

    /**
     * Reads the next argument and steps past it, or `undefined` when there is
     * nothing usable there.
     *
     * Refusing rather than substituting `''` is the point. `--host` with nothing
     * after it would otherwise become `--host ''`, which the CLI accepts and reads
     * as "ask the user", and `--target --apk` would consume the next *flag* as an
     * ABI and report "not a known target" — a reason that has nothing to do with
     * what the operator typed.
     */
    const value = (): string | undefined => {
      const next = rest[index + 1] ?? '';
      if (next.trim().length === 0 || next.startsWith('--')) {
        return undefined;
      }
      index += 1;
      return next;
    };

    const required = (read: () => string | undefined): string | MobileParseFailure => {
      const outcome = read();
      return (
        outcome ?? {
          ok: false,
          message: `${arg} needs a value.`,
          remedy:
            `\`tauri ${platform} ${mode}\` reads ${arg}'s value from the next argument. ` +
            'A missing one, an empty one, or another flag in its place is refused here ' +
            'rather than forwarded as an empty string the CLI would interpret.',
        }
      );
    };

    switch (arg) {
      case '--target': {
        const target = required(value);
        if (typeof target !== 'string') {
          return target;
        }
        parsed.targets = [...(parsed.targets ?? []), target];
        break;
      }
      case '--features': {
        const features = required(value);
        if (typeof features !== 'string') {
          return features;
        }
        parsed.features = features.split(',').filter((entry) => entry.length > 0);
        break;
      }
      case '--host': {
        const host = required(value);
        if (typeof host !== 'string') {
          return host;
        }
        parsed.host = host;
        break;
      }
      case '--export-method': {
        const method = required(value);
        if (typeof method !== 'string') {
          return method;
        }
        if (!(IOS_EXPORT_METHODS as readonly string[]).includes(method)) {
          return {
            ok: false,
            message: `--export-method "${method}" is not one of the CLI's values.`,
            remedy: `Expected: ${IOS_EXPORT_METHODS.join(', ')}.`,
          };
        }
        parsed.exportMethod = method as IosExportMethod;
        break;
      }
      case '--build-number': {
        const raw = required(value);
        if (typeof raw !== 'string') {
          return raw;
        }
        const buildNumber = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(buildNumber) || buildNumber < 1) {
          return {
            ok: false,
            message: `--build-number "${raw}" is not a positive integer.`,
            remedy: 'It is CFBundleVersion; it must increase with every upload.',
          };
        }
        parsed.buildNumber = buildNumber;
        break;
      }
      case '--apk':
        parsed.apk = true;
        break;
      case '--aab':
        parsed.aab = true;
        break;
      case '--split-per-abi':
        parsed.splitPerAbi = true;
        break;
      case '--debug':
        parsed.debug = true;
        break;
      case '--release':
        parsed.release = true;
        break;
      case '--no-sign':
        parsed.noSign = true;
        break;
      case '--archive-only':
        parsed.archiveOnly = true;
        break;
      case '--open':
        parsed.open = true;
        break;
      case '--ci':
        parsed.ci = true;
        break;
      case '--skip-targets-install':
        parsed.skipTargetsInstall = true;
        break;
      case '--reinstall-deps':
        parsed.reinstallDeps = true;
        break;
      case '--no-watch':
        parsed.noWatch = true;
        break;
      case '--no-dev-server-wait':
        parsed.noDevServerWait = true;
        break;
      case '--force-ip-prompt':
        parsed.forceIpPrompt = true;
        break;
      case '--exit-on-panic':
        parsed.exitOnPanic = true;
        break;
      case '--additional-watch-folders': {
        const folder = required(value);
        if (typeof folder !== 'string') {
          return folder;
        }
        parsed.additionalWatchFolders = [...(parsed.additionalWatchFolders ?? []), folder];
        break;
      }
      case '--port': {
        const raw = required(value);
        if (typeof raw !== 'string') {
          return raw;
        }
        const port = Number(raw);
        if (!/^\d+$/.test(raw) || port < 1 || port > 65_535) {
          return {
            ok: false,
            message: `--port "${raw}" is not a TCP port.`,
            remedy: "It is the CLI's own static dev-server port, not NATIVE_DEV_PORT.",
          };
        }
        parsed.port = port;
        break;
      }
      // Accepted and dropped. The CLI's verbosity is a display choice the caller
      // makes with its own terminal, and forwarding it from a script would mean
      // every log line in CI carried the same `-v` count.
      case '--verbose':
        break;
      default:
        // Unreachable: `known` was checked above, and every member of the table
        // has a case. Kept rather than `break`, because a flag added to the
        // table and not here would otherwise be silently dropped.
        return {
          ok: false,
          message: `${arg} is in the accepted-flag list but this parser does not read it.`,
          remedy: 'That is a defect in scripts/src/native/mobile.ts, not in your command.',
        };
    }
  }

  return {
    ok: true,
    options: {
      platform,
      mode: mode as MobileMode,
      ...(parsed.targets === undefined ? {} : { targets: parsed.targets }),
      ...(parsed.device === undefined ? {} : { device: parsed.device }),
      ...(parsed.host === undefined ? {} : { host: parsed.host }),
      ...(parsed.features === undefined ? {} : { features: parsed.features }),
      ...(parsed.forceIpPrompt === undefined ? {} : { forceIpPrompt: parsed.forceIpPrompt }),
      ...(parsed.apk === undefined ? {} : { apk: parsed.apk }),
      ...(parsed.aab === undefined ? {} : { aab: parsed.aab }),
      ...(parsed.splitPerAbi === undefined ? {} : { splitPerAbi: parsed.splitPerAbi }),
      ...(parsed.debug === undefined ? {} : { debug: parsed.debug }),
      ...(parsed.release === undefined ? {} : { release: parsed.release }),
      ...(parsed.exportMethod === undefined ? {} : { exportMethod: parsed.exportMethod }),
      ...(parsed.buildNumber === undefined ? {} : { buildNumber: parsed.buildNumber }),
      ...(parsed.noSign === undefined ? {} : { noSign: parsed.noSign }),
      ...(parsed.archiveOnly === undefined ? {} : { archiveOnly: parsed.archiveOnly }),
      ...(parsed.open === undefined ? {} : { open: parsed.open }),
      ...(parsed.ci === undefined ? {} : { ci: parsed.ci }),
      ...(parsed.skipTargetsInstall === undefined
        ? {}
        : { skipTargetsInstall: parsed.skipTargetsInstall }),
      ...(parsed.reinstallDeps === undefined ? {} : { reinstallDeps: parsed.reinstallDeps }),
      ...(parsed.noWatch === undefined ? {} : { noWatch: parsed.noWatch }),
      ...(parsed.noDevServerWait === undefined ? {} : { noDevServerWait: parsed.noDevServerWait }),
      ...(parsed.exitOnPanic === undefined ? {} : { exitOnPanic: parsed.exitOnPanic }),
      ...(parsed.additionalWatchFolders === undefined
        ? {}
        : { additionalWatchFolders: parsed.additionalWatchFolders }),
      ...(parsed.port === undefined ? {} : { port: parsed.port }),
    },
  };
};

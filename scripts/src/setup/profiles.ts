// scripts/src/setup/profiles.ts
//
// What a lane needs, stated once, so `setup` and `doctor` cannot disagree.
//
// A doctor that reports one flat list has to pick: require Rust and WebKitGTK, and
// a web contributor on a laptop without them cannot install; or call them optional,
// and `native:build` then fails four minutes in with a linker error while doctor
// said the host was fine. Neither is acceptable, and the fix is not a compromise
// between them — it is asking *which lane* the question is about.
//
// So: five named profiles, each with its own prerequisites and its own remedy, and
// a `web` profile that is the only one `bun run setup` requires. Selecting a profile
// never relaxes a check; it changes which checks are asked at all.
//
// The existing `doctor.ts` checks are unchanged and still all run: a profile only
// *classifies* them, so `bun run setup:doctor` reports the same host capability
// facts as before with the profile attached, and a new profile cannot silently drop
// a check.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NATIVE_DIR, REPO_ROOT } from '../shared/paths.ts';
import type { Check } from './doctor.ts';

export const PROFILES = ['web', 'native', 'android', 'ios', 'compute', 'database'] as const;
export type Profile = (typeof PROFILES)[number];

/**
 * The *core* doctor checks each profile draws on. The platform checks it adds are
 * read off `profileChecks` itself by {@link profileCheckNames}, so a check that is
 * added there cannot go missing from the header `setup` prints — which is how
 * `docker-engine` came to run, decide the exit code, and never be named.
 */
const CORE_PROFILE_CHECKS: Record<Profile, readonly string[]> = {
  // The credential-free core. No Docker, no Xcode, no Android SDK, no cloud key.
  web: ['bun', 'pins', 'proto', 'node', 'wrangler', 'config', 'playwright', 'chromium', 'sops'],
  // Desktop shell: Rust toolchain and, on Linux, the webview development files.
  native: ['bun', 'pins', 'proto', 'node', 'wrangler', 'config', 'rust', 'webview', 'cargo-native'],
  android: ['bun', 'pins', 'proto', 'node', 'rust', 'android-sdk', 'android-jdk', 'cargo-native'],
  ios: ['bun', 'pins', 'proto', 'node', 'rust', 'xcode', 'apple-toolchain'],
  // Real containers, locally: a Docker-compatible engine is the only prerequisite.
  compute: [
    'bun',
    'pins',
    'proto',
    'node',
    'wrangler',
    'config',
    'docker',
    'docker-engine',
    'cargo-media',
  ],
  database: ['bun', 'pins', 'proto', 'docker', 'docker-engine'],
};

export const isProfile = (value: unknown): value is Profile =>
  typeof value === 'string' && (PROFILES as readonly string[]).includes(value);

/**
 * A command's first line of output, or `null` when it did not run.
 *
 * The same probe `doctor.ts` uses, reached through its export rather than
 * reimplemented: two copies of "run it and read stdout" is how a doctor ends up
 * reporting a green line for a binary that does not exist.
 */
const probe = (command: string, args: readonly string[]): string | null => {
  const result = spawnSync(command, [...args], { encoding: 'utf8', timeout: 60_000 });
  if (result.error !== undefined || result.status !== 0) {
    return null;
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n')[0]?.trim() ?? '';
};

const firstExisting = (candidates: readonly string[]): string | null =>
  candidates.find((candidate) => existsSync(candidate)) ?? null;

const ANDROID_ENV_HINTS = [
  join(process.env.HOME ?? '', 'Android/Sdk'),
  join(process.env.HOME ?? '', 'Library/Android/sdk'),
  '/usr/lib/android-sdk',
  '/opt/android-sdk',
] as const;

/**
 * The platform checks a profile adds, built from what this host actually offers.
 *
 * Each check runs the thing or names the one environment variable that would point
 * at it. None of them is "is a file present" where running it is possible, because
 * that distinction is the entire reason `doctor.ts` exists.
 */
export const profileChecks = (profile: Profile, runProbe = probe): Check[] => {
  const out: Check[] = [];

  if (profile === 'native' || profile === 'android' || profile === 'ios') {
    const rustc = runProbe('rustc', ['--version']);
    const pinned = join(NATIVE_DIR, 'src-tauri', 'rust-toolchain.toml');
    out.push({
      name: 'rust',
      severity: 'required',
      ok: rustc !== null,
      detail: rustc ?? 'not on PATH',
      ...(rustc === null
        ? {
            remedy:
              'Install Rust through `nix develop`, or rustup. `native:build`, `native:android`\n' +
              `    and \`native:ios\` all compile Rust; the pinned toolchain is in\n    ${pinned}.`,
          }
        : {}),
    });
  }

  if (profile === 'native') {
    // Linux only, and said so.
    //
    // The check asked `pkg-config` for `webkit2gtk-4.1` on every platform, so a macOS
    // or Windows host — where the webview is part of the OS and no such package
    // exists — reported a required capability it could never satisfy. The remedy text
    // even said so, which made the failure read as a bug in the checker.
    if (process.platform === 'linux') {
      const webview = runProbe('pkg-config', ['--exists', 'webkit2gtk-4.1']);
      out.push({
        name: 'webview',
        severity: 'required',
        ok: webview !== null,
        detail:
          webview !== null ? 'webkit2gtk-4.1 found by pkg-config' : 'webkit2gtk-4.1 not found',
        ...(webview !== null
          ? {}
          : {
              remedy:
                'Linux desktop builds need the WebKitGTK 4.1 development files:\n' +
                '    Debian/Ubuntu: sudo apt-get install libwebkit2gtk-4.1-dev\n' +
                '    Fedora:        sudo dnf install webkit2gtk4.1-devel\n' +
                '  macOS and Windows need no such package: their webview ships with the OS.\n' +
                '  `nix develop` supplies it on Linux.',
            }),
      });
    }
    out.push({
      name: 'cargo-native',
      severity: 'required',
      ok: existsSync(join(NATIVE_DIR, 'src-tauri', 'Cargo.toml')),
      detail: existsSync(join(NATIVE_DIR, 'src-tauri', 'Cargo.toml'))
        ? `${NATIVE_DIR}/src-tauri/Cargo.toml present`
        : `${NATIVE_DIR}/src-tauri/Cargo.toml is missing`,
      ...(existsSync(join(NATIVE_DIR, 'src-tauri', 'Cargo.toml'))
        ? {}
        : { remedy: 'Restore apps/frontend/native/src-tauri from the template.' }),
    });
  }

  if (profile === 'android') {
    const sdk =
      process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? firstExisting(ANDROID_ENV_HINTS);
    const sdkPresent = sdk !== null && existsSync(sdk);
    out.push({
      name: 'android-sdk',
      severity: 'required',
      ok: sdkPresent,
      detail: sdkPresent
        ? `ANDROID_HOME resolved to ${sdk}`
        : 'no Android SDK: set ANDROID_HOME or ANDROID_SDK_ROOT',
      ...(sdkPresent
        ? {}
        : {
            remedy:
              'Install the Android SDK (platform-tools, platform-tools build-tools, an\n' +
              '    NDK matching the pinned Rust target) and export ANDROID_HOME.\n' +
              '    bun run setup:doctor --profile android   # repeats this check\n' +
              '    bun run native:doctor -- --platform android  # the same, through the native CLI',
          }),
    });

    const javac = runProbe('javac', ['-version']);
    out.push({
      name: 'android-jdk',
      severity: 'required',
      ok: javac !== null,
      detail: javac ?? 'javac not on PATH',
      ...(javac === null
        ? {
            remedy:
              'A JDK 17 or newer is required to build an APK. Install it, or run\n' +
              '    `bun run native:android` inside `nix develop`, which supplies one.',
          }
        : {}),
    });

    out.push({
      name: 'cargo-native',
      severity: 'required',
      ok: existsSync(join(NATIVE_DIR, 'src-tauri', 'Cargo.toml')),
      detail: 'apps/frontend/native/src-tauri/Cargo.toml',
      ...(existsSync(join(NATIVE_DIR, 'src-tauri', 'Cargo.toml'))
        ? {}
        : { remedy: 'Restore apps/frontend/native/src-tauri from the template.' }),
    });
  }

  if (profile === 'ios') {
    const mac = process.platform === 'darwin';
    out.push({
      name: 'xcode',
      // Required on every host: this one cannot be "optional", because a Linux
      // machine simply cannot build an iOS bundle and saying otherwise is the
      // "an unavailable lane reported as healthy" failure.
      severity: 'required',
      ok: mac && runProbe('xcodebuild', ['-version']) !== null,
      detail: mac
        ? (runProbe('xcodebuild', ['-version']) ?? 'xcodebuild does not run')
        : `host is ${process.platform}, not macOS`,
      ...(mac
        ? {}
        : {
            remedy:
              'iOS builds require macOS with the full Xcode installed. This lane cannot run here.',
          }),
    });
    out.push({
      name: 'apple-toolchain',
      severity: 'required',
      ok: mac && existsSync('/Applications/Xcode.app'),
      detail: mac ? 'Xcode.app present' : 'host is not macOS',
      ...(mac && existsSync('/Applications/Xcode.app')
        ? {}
        : {
            remedy:
              'Install the full Xcode from the App Store (not just the command line tools) —\n' +
              '    a simulator build needs the platform runtimes it bundles.',
          }),
    });
  }

  if (profile === 'compute' || profile === 'database') {
    const docker = runProbe('docker', ['--version']);
    out.push({
      name: 'docker',
      severity: 'required',
      ok: docker !== null,
      detail: docker ?? 'not on PATH',
      ...(docker === null
        ? {
            remedy:
              `${profile === 'database' ? '`bun run test:database` runs real Postgres and the Supabase Data API in a checkout-owned stack.\n' : '`bun run test:compute` runs the media container in a real Docker-compatible\n'}` +
              '    engine. Install Docker or Podman and make sure the daemon is running.\n' +
              '    Without it this lane exits nonzero; it never falls back to a mock.',
          }
        : {}),
    });

    // Plain `docker info`, with no `--format`. The format template is a version-
    // dependent surface — this host's engine rejects `{{.ServerVersion}}` outright,
    // and a check that reports "the daemon is not answering" when the daemon is
    // answering is worse than no check, because it sends an operator to start a
    // service that is already running.
    const reachable = docker === null ? null : runProbe('docker', ['info']);
    out.push({
      name: 'docker-engine',
      severity: 'required',
      ok: reachable !== null,
      detail: reachable === null ? 'the Docker daemon is not answering' : 'docker info answered',
      ...(reachable === null
        ? {
            remedy:
              'The binary is present but nothing is listening. Start the engine (Docker\n' +
              '    Desktop, `dockerd`, or `podman system service`) and re-run.',
          }
        : {}),
    });
  }

  if (profile === 'compute') {
    // From `REPO_ROOT`, not the working directory.
    //
    // `join('apps', 'backend', 'media', 'Cargo.toml')` is relative to wherever the
    // process was started, so `bun run setup:doctor` from a subdirectory reported a
    // missing crate in a repository that has it — and the remedy told the operator to
    // restore a file that was never gone.
    const mediaManifest = join(REPO_ROOT, 'apps', 'backend', 'media', 'Cargo.toml');
    const mediaPresent = existsSync(mediaManifest);
    out.push({
      name: 'cargo-media',
      severity: 'required',
      ok: mediaPresent,
      detail: mediaPresent ? mediaManifest : `${mediaManifest} is missing`,
      ...(mediaPresent ? {} : { remedy: 'Restore apps/backend/media from the template.' }),
    });
  }

  return out;
};

/**
 * The names of the checks `profileChecks` emits for a profile.
 *
 * Reuse the check construction without launching host tools: names do not depend
 * on probe results. The real doctor uses the default probe and still runs every
 * capability check. Listing names must not wait for toolchain downloads or Docker.
 */
export const platformCheckNames = (profile: Profile): string[] =>
  profileChecks(profile, () => null).map((check) => check.name);

/**
 * Every check a profile asks about: the core ones it draws on, plus the platform ones
 * it adds.
 *
 * `web` deliberately does not include Docker, Rust, Xcode or the Android SDK, and
 * that omission is the product decision: the web lane is the one a new contributor
 * runs, and requiring four toolchains to install it is how a template stops being a
 * template.
 */
export const profileCheckNames = (profile: Profile): string[] => [
  ...new Set([...CORE_PROFILE_CHECKS[profile], ...platformCheckNames(profile)]),
];

/**
 * The remedy for a profile whose prerequisites are missing, as one command.
 *
 * A named profile with an unmet prerequisite fails with *this*, rather than
 * continuing into a build that will fail four minutes later with a linker error.
 */
export const profileRefusal = (profile: Profile, missing: readonly string[]): string => {
  if (missing.length === 0) {
    return '';
  }

  const lines = [
    `The "${profile}" profile needs ${missing.join(', ')}, which this host does not have.`,
    '  Nothing was changed. Two ways forward:',
  ];

  if (process.platform === 'linux' || process.platform === 'darwin') {
    lines.push('    nix develop        # supplies every prerequisite this repository pins');
  }
  lines.push(
    `    bun run setup:doctor --profile ${profile}   # the same check, with per-check detail`,
  );
  lines.push(
    '    bun run setup:doctor --profile web      # what the web lane needs, which is less',
  );

  return lines.join('\n');
};

/** The `web` profile's own remedy, used by the core lanes. */
export const CORE_REMEDY = (): string =>
  'The web profile needs nothing beyond Bun, Node and the workspace install.\n' +
  '  It deliberately does not require Docker, Xcode, an Android SDK or any cloud key.\n' +
  '    nix develop        # or: bun install && bun run setup';

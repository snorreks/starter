// apps/frontend/client/scripts/build_tauri.ts
//
//   bun run tauri:dev                     # desktop, dev reload
//   bun run tauri:build                   # desktop release bundle
//   bun run tauri:build -- --target android
//   bun run tauri:build -- --debug        # unoptimised bundle, for a local check
//
// Why this exists rather than `"tauri:build": "tauri build"`:
//
// 1. **The `@tauri-apps/*` stub must be off for every native target.** `vite.config.ts`
//    replaces the Tauri packages with a throwing stub unless a native-build flag is
//    set. The flag was called `TAURI_DESKTOP_BUILD`, which reads as "desktop only" —
//    so an Android or iOS build launched without it shipped stubbed Tauri packages,
//    i.e. an app whose native calls throw. This script sets the flag for every
//    native target, and `vite.config.ts` accepts it under both names.
//
// 2. **`tauri` must resolve to the pinned workspace copy.** It is declared by this
//    package, so `bunx tauri` from the repository root does not find it and downloads
//    whatever the registry serves. Same failure mode as `bunx wrangler`.
//
// 3. **The dev server port has to be pinned to the one `tauri.conf.json` names.**
//    Tauri v2 does not interpolate environment variables into its config, so
//    `build.devUrl` is a literal that `tauri dev` will load. If `PORT` is set for
//    this invocation and does not match that literal, the window opens on nothing.
//    This script detects the mismatch and refuses rather than showing a blank
//    webview.
//
// 4. **A host that cannot build the requested target should say so.** Building for
//    Android needs the SDK/NDK; iOS needs Xcode and macOS. "tauri exits with a
//    linker error" is a worse message than naming the missing prerequisite.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIENT_DEV_PORT, DEV_HOST } from '../dev_ports.ts';

const CLIENT_DIR = fileURLToPath(new URL('../', import.meta.url));
const TAURI_CONF = fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url));

export type NativeTarget = 'desktop' | 'android' | 'ios';

export interface ResolvedInvocation {
  /** Subcommand for the tauri CLI. */
  tauriArgs: string[];
  target: NativeTarget;
  mode: 'dev' | 'release';
  /** Environment additions applied to the child process. */
  env: Record<string, string>;
  /** Non-empty when the host cannot build this target. */
  blocked: string | null;
}

const TARGET_FLAG: Record<NativeTarget, string> = {
  desktop: '',
  android: '--android',
  ios: '--ios',
};

/**
 * Which platform this invocation is for.
 *
 * Two spellings are accepted, and both matter. `--android` / `--ios` / `--desktop`
 * name the platform directly; `--target android` is the form the tauri CLI
 * documents and the one `docs/native.md` uses.
 *
 * Reading both is not tidiness. `hostBlocker` is asked about the target, so a
 * launcher that did not recognise `--target android` would check for cargo, report
 * nothing about the SDK, and let the build fail later inside Gradle — which is the
 * "tauri exits with a linker error" outcome this script exists to replace.
 *
 * A `--target` triple (`aarch64-apple-ios`) is passed through untouched and is not
 * resolved to a platform here; no bundled target needs that today.
 */
export const parseTarget = (args: readonly string[]): NativeTarget | null => {
  if (args.includes('--android')) {
    return 'android';
  }
  if (args.includes('--ios')) {
    return 'ios';
  }
  if (args.includes('--desktop')) {
    return 'desktop';
  }
  const flagIndex = args.indexOf('--target');
  const named = flagIndex === -1 ? undefined : args[flagIndex + 1];
  if (named === 'android') {
    return 'android';
  }
  if (named === 'ios') {
    return 'ios';
  }
  return null;
};

/**
 * Read the devUrl literal out of tauri.conf.json.
 *
 * A regex rather than a JSONC parser because this file is the one place the
 * mismatch can be detected cheaply and the value is a single well-known field. If
 * the shape ever stops matching, `hostBlocker` reports that it could not verify,
 * which is a refusal rather than a silent pass.
 */
export const readConfiguredDevUrl = (path: string = TAURI_CONF): string | null => {
  if (!existsSync(path)) {
    return null;
  }
  const match = /"devUrl"\s*:\s*"([^"]+)"/.exec(readFileSync(path, 'utf8'));
  return match?.[1] ?? null;
};

/**
 * The NDK an Android build would link against, or null when there is none.
 *
 * Gradle looks under `$ANDROID_HOME/ndk/<version>`, and several versions can be
 * installed side by side — so any of them can link, and the highest is the one a
 * build would pick. `ANDROID_NDK_HOME` / `NDK_HOME` are the escape hatches for an
 * NDK installed outside the SDK.
 */
const androidNdk = (sdk: string): string | null => {
  const configured = process.env.ANDROID_NDK_HOME ?? process.env.NDK_HOME;
  if (configured !== undefined && configured.length > 0) {
    return existsSync(configured) ? configured : null;
  }

  const ndkRoot = join(sdk, 'ndk');
  if (!existsSync(ndkRoot)) {
    return null;
  }
  const versions = readdirSync(ndkRoot)
    .filter((name) => existsSync(join(ndkRoot, name, 'toolchains')))
    .sort();
  const latest = versions.at(-1);
  return latest === undefined ? null : join(ndkRoot, latest);
};

/** What this host is missing, or null when it can build the target. */
export const hostBlocker = (target: NativeTarget): string | null => {
  if (target === 'desktop') {
    // Cargo absence is the only universal desktop blocker. System webview
    // libraries (webkit2gtk, GTK) are a link error at worst, and their message
    // names the exact package; naming every distro's package set here would be
    // worse advice than the real error.
    return spawnSync('cargo', ['--version'], { stdio: 'ignore' }).status === 0
      ? null
      : 'cargo is not on PATH. Install the Rust toolchain (https://rustup.rs) to build the desktop bundle.';
  }

  if (target === 'ios') {
    if (process.platform !== 'darwin') {
      return 'iOS builds require macOS with Xcode. On this host that is not possible.';
    }
    return spawnSync('xcodebuild', ['-version'], { stdio: 'ignore' }).status === 0
      ? null
      : 'xcodebuild is not available. Install Xcode and its command line tools.';
  }

  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (sdk === undefined || !existsSync(sdk)) {
    return 'ANDROID_HOME / ANDROID_SDK_ROOT is not set or does not exist. Android builds need the SDK and the NDK.';
  }
  if (process.platform === 'darwin') {
    // Homebrew's android-ndk supplies the toolchain but the SDK root still has to
    // be pointed at; the message above covers the unset case.
    return null;
  }
  // `null` is a claim that this host *can* build the target, so the NDK is checked
  // rather than assumed. An SDK root with no NDK otherwise fails as a linker error
  // several minutes in, and naming the missing prerequisite is the entire point of
  // this function. macOS returned above because Homebrew can supply the NDK outside
  // the SDK.
  if (androidNdk(sdk) === null) {
    return (
      `${sdk} has no Android NDK. Install one into the SDK with ` +
      '`sdkmanager "ndk;<version>"` (then accept its licences), or point ANDROID_NDK_HOME at an ' +
      'existing NDK. Android builds link native libraries, so the NDK is required.'
    );
  }
  return null;
};

/**
 * Build the invocation. Pure apart from the two injected seams, so the decision
 * table is testable on a host that cannot actually build a native bundle.
 */
export const resolveInvocation = (
  mode: 'dev' | 'release',
  args: readonly string[],
  opts: {
    clientPort?: number;
    devHost?: string;
    /** Injected so the port rules can be checked without cargo/Xcode present. */
    blocker?: (target: NativeTarget) => string | null;
    /** Injected so the port rules can be checked without reading the real config. */
    devUrl?: string | null;
  } = {},
): ResolvedInvocation => {
  const target = parseTarget(args) ?? 'desktop';
  const clientPort = opts.clientPort ?? CLIENT_DEV_PORT;
  const host = opts.devHost ?? DEV_HOST;
  let blocked = (opts.blocker ?? hostBlocker)(target);
  const devUrl = opts.devUrl === undefined ? readConfiguredDevUrl() : opts.devUrl;

  // `tauri dev` drives a dev server and needs the port to line up. `tauri build`
  // compiles `frontendDist` and never reads devUrl, so the check is dev-only.
  if (mode === 'dev' && blocked === null) {
    if (devUrl === null) {
      blocked = `Could not read build.devUrl from ${TAURI_CONF}. Check it exists.`;
    } else {
      let parsed: URL | null = null;
      try {
        parsed = new URL(devUrl);
      } catch {
        blocked = `build.devUrl in tauri.conf.json is not a valid URL: ${devUrl}`;
      }
      if (parsed !== null && Number(parsed.port || '80') !== clientPort) {
        blocked =
          `PORT=${clientPort} but tauri.conf.json's devUrl is ${devUrl}. ` +
          'Tauri v2 does not read env vars from its config, so the two must agree. ' +
          `Either unset PORT, or run: tauri dev --config '{"build":{"devUrl":"http://${host}:${clientPort}"}}'`;
      }
    }
  }

  const passthrough = args.filter(
    (arg) => arg !== '--android' && arg !== '--ios' && arg !== '--desktop',
  );
  // Synthesised only for the `--android` / `--ios` spelling. A caller who wrote
  // `--target android` already named the platform, and `tauri build --android
  // --target android` asks for two things.
  const flag = args.includes('--target') ? '' : TARGET_FLAG[target];

  const tauriArgs =
    mode === 'dev'
      ? ['dev', ...(flag === '' ? [] : [flag]), ...passthrough]
      : ['build', ...(flag === '' ? [] : [flag]), ...passthrough];

  return {
    tauriArgs,
    target,
    mode,
    blocked,
    env: {
      // Accurate name: true for desktop, Android and iOS alike. The old name
      // implied desktop-only and silently stubbed the mobile builds.
      TAURI_NATIVE_BUILD: 'true',
      // Accepted alias, so an existing invocation or a muscle-memory `PORT=…`
      // export still works. Both names switch off the stub.
      TAURI_DESKTOP_BUILD: 'true',
      PORT: String(clientPort),
    },
  };
};

/** The pinned tauri binary from this package's node_modules/.bin. */
export const tauriBin = (): string | null => {
  const candidate = fileURLToPath(new URL('../node_modules/.bin/tauri', import.meta.url));
  return existsSync(candidate) ? candidate : null;
};

const passthroughArgs = (argv: readonly string[]): string[] =>
  argv.slice(argv[0] === 'dev' || argv[0] === 'build' ? 1 : 0);

export const main = (argv: readonly string[]): number => {
  const mode: 'dev' | 'release' = argv[0] === 'dev' ? 'dev' : 'build';
  const args = passthroughArgs(argv);

  const invocation = resolveInvocation(mode, args);
  const label = `tauri ${invocation.tauriArgs.join(' ')}`;

  if (invocation.blocked !== null) {
    process.stderr.write(`${label}\n\n  ${invocation.blocked}\n\nNothing was built.\n`);
    return 1;
  }

  const bin = tauriBin();
  if (bin === null) {
    process.stderr.write(
      'tauri is not installed. It is a pinned dependency of apps/frontend/client.\n' +
        'Run `bun install` from the repository root.\n',
    );
    return 1;
  }

  process.stdout.write(`${label}\n`);
  const result = spawnSync(bin, invocation.tauriArgs, {
    stdio: 'inherit',
    cwd: CLIENT_DIR,
    env: { ...process.env, ...invocation.env },
  });

  if (result.error !== undefined) {
    process.stderr.write(`could not run tauri: ${result.error.message}\n`);
    return 1;
  }

  const code = result.status ?? 1;
  if (code === 0) {
    process.stdout.write(
      `built ${invocation.target}/${invocation.mode}. ` +
        'Nothing was signed: see docs/native.md for the signing prerequisites.\n',
    );
  }
  return code;
};

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}

export type { ResolvedInvocation };

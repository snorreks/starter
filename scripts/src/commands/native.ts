// scripts/src/commands/native.ts
//
// `bun run native:dev`, `bun run native:build`, `bun run native:doctor`
//
// One command with three subcommands, because they share everything: the same
// working directory, the same pinned CLI resolution, and the same rule that a
// missing prerequisite is reported by name instead of surfacing as a linker error
// twenty minutes later.
//
// The launch itself is deliberately thin. Everything that could be decided without
// running a process — the argv, the working directory, which flags exist — is a
// pure function in `../native/platform.ts`, and `scripts/tests/native_cli.test.ts`
// asserts it on a machine with no Rust toolchain. What is left here is: resolve the
// binary, check the capability, run it with inherited stdio, and return the CLI's
// own exit status. A desktop app that fails to start exits nonzero, because
// `spawnSync().status` is the answer and inventing one would be the snapshot's
// `.ok()`.

import { spawnSync } from 'node:child_process';
import { DEV_API_HOST_ENV } from '@starter/schemas/native';
import { nativeConfiguration } from '../native/config.ts';
import { inspectNative, renderNativeReport } from '../native/doctor.ts';
import {
  type MobileMode,
  type MobilePlatform,
  parseMobileArgs,
  planMobileInvocation,
} from '../native/mobile.ts';
import { inspectAndroid, inspectIos, renderMobileReport } from '../native/mobile_prerequisites.ts';
import {
  NATIVE_DIR,
  type PlanOptions,
  parseNativeArgs,
  planInvocation,
} from '../native/platform.ts';
import type { Command } from '../shared/command.ts';
import { EXIT, fail, wantsHelp } from '../shared/command.ts';
import { resolveWorkspaceBin } from '../shared/tools.ts';

const USAGE = `native <doctor|dev|build|android|ios> [flags]

Runs the pinned Tauri CLI for apps/frontend/native.

  doctor            report what this host can build, and what it cannot
  dev               tauri dev: the static app plus the shell, on the dev port
  build             tauri build: a release binary and its installer
  android <mode>    tauri android init|dev|build|run
  ios <mode>        tauri ios init|dev|build|run  (macOS with full Xcode only)

Flags
  --linux | --macos | --windows    this host, named explicitly (desktop only)
  --platform <name>                the same thing, spelled as a value
  --target <triple>                a Rust target triple, e.g. x86_64-apple-darwin
  --features <a,b>                 cargo features
  --no-bundle                      build the binary without an installer
  --platform android|ios           what \`doctor\` reports on (default: desktop)

Mobile flags (see \`native android --help\` and \`native ios --help\`)
  --target <abi>                   Android: aarch64|armv7|i686|x86_64
                                   iOS:     aarch64|aarch64-sim|x86_64
                                   NOT a Rust triple; the CLI takes no triples
  --device <name>                  run on that device or simulator by name
  --host <address>                 dev only: reach the API and the dev server
                                   from a physical phone, not from loopback
  --apk | --aab                    Android: which package to produce
  --split-per-abi                  Android: one package per ABI
  --debug | --release              build flavour for dev/run/build
  --export-method <method>         iOS: app-store-connect|release-testing|debugging
  --no-sign | --archive-only       iOS: unsigned archive, archive without an IPA
  --build-number <n>               iOS: CFBundleVersion
  --ci                             never prompt; required in CI
  --skip-targets-install           do not let the CLI run rustup target add
  --open                           open the IDE instead of launching
  --no-watch | --no-dev-server-wait | --exit-on-panic | --force-ip-prompt
  --port <n> | --additional-watch-folders <path>

A platform name resolves to this host's Rust target triple, because the Tauri 2
CLI has no platform flag at all. A platform that is not this one is refused: a
desktop binary is built on its own operating system, and the desktop matrix in
.github/workflows/native.yml has one runner per OS.

A *mobile* target is neither a triple nor a platform name. \`--target\` takes the
ABI or architecture the pinned CLI lists, and \`--host\` is how a phone reaches
your machine: its localhost is its own.

Examples
  bun run native:doctor
  bun run native:doctor -- --platform android
  bun run native:dev
  bun run native:build -- --no-bundle
  bun run native:build -- --target aarch64-apple-darwin
  bun run native:android -- init --ci
  bun run native:android -- build --aab --ci
  bun run native:android -- dev --host 192.168.1.20 "Pixel 8"
  bun run native:ios -- build --target aarch64-sim --ci`;

const doctor = (platform: string | undefined): number => {
  if (platform === 'android') {
    const report = inspectAndroid();
    process.stdout.write(`${renderMobileReport(report)}\n`);
    return report.ok ? EXIT.ok : EXIT.unavailable;
  }
  if (platform === 'ios') {
    const report = inspectIos();
    process.stdout.write(`${renderMobileReport(report)}\n`);
    return report.ok ? EXIT.ok : EXIT.unavailable;
  }
  if (platform !== undefined) {
    return fail(
      `--platform "${platform}" is not something this doctor reports on.\n` +
        `  Expected: desktop (the default), android, ios.`,
      EXIT.usage,
    );
  }

  const report = inspectNative();
  process.stdout.write(`${renderNativeReport(report)}\n`);
  return report.ok ? EXIT.ok : EXIT.unavailable;
};

/**
 * Run one planned mobile invocation.
 *
 * The configuration is built here rather than inside the planner, because it
 * depends on the flag: `--host` widens the dev server binding and moves the API
 * origin to the same address, and both are refused for anything that is not a
 * `dev` subcommand. `resolveApiOrigin` throws for the combinations that make no
 * sense (a device host in a packaged build), and that is reported with its own
 * message rather than as a generic launch failure.
 */
const launchMobile = (options: {
  readonly platform: MobilePlatform;
  readonly mode: MobileMode;
  readonly host?: string | undefined;
}): number => {
  const planned = planMobileInvocation(options);
  if (!planned.ok) {
    return fail(
      `${planned.message}\n  ${planned.remedy}`,
      planned.kind === 'unavailable' ? EXIT.unavailable : EXIT.usage,
    );
  }

  const devMode = options.mode === 'dev';
  if (options.host !== undefined && !devMode) {
    return fail(
      '--host only applies to `dev`. A packaged build embeds its own assets and ' +
        'reaches one configured API origin.',
      EXIT.usage,
    );
  }

  let configuration: ReturnType<typeof nativeConfiguration>;
  try {
    configuration = nativeConfiguration(
      devMode ? 'dev' : 'build',
      process.env,
      undefined,
      options.host,
    );
  } catch (error) {
    return fail(String(error), EXIT.usage);
  }

  const report = options.platform === 'android' ? inspectAndroid() : inspectIos();
  if (!report.ok) {
    process.stderr.write(`${renderMobileReport(report)}\n`);
    // 3 rather than 1: refused for an absent prerequisite, which is a different
    // answer from "the build ran and failed".
    return EXIT.unavailable;
  }

  const bin = resolveWorkspaceBin('tauri', [NATIVE_DIR]);
  if (bin === null) {
    return fail(
      'The pinned Tauri CLI could not be resolved. Run `bun install` from the repository root.',
      EXIT.unavailable,
    );
  }

  const { args, cwd } = planned.invocation;
  const result = spawnSync(bin, [...args, '--config', configuration.config], {
    stdio: 'inherit',
    cwd,
    // Two things beyond the process environment:
    //
    //   * `NATIVE_DEV_HOST=0.0.0.0` — the CLI rewrites `devUrl` to the public
    //     address when `--host` is given, but the Vite server it points at is
    //     still bound to loopback and would refuse the connection. Widening the
    //     binding here, and only here, is what makes `--host` mean anything.
    //   * `VITE_NATIVE_DEV_API_HOST` — the same address, so the *frontend* also
    //     talks to the machine that serves it rather than to the phone's own
    //     loopback. `resolveApiOrigin` refuses this pair outside a dev build, so
    //     the same variable cannot leak into a packaged bundle.
    env:
      options.host === undefined
        ? configuration.env
        : {
            ...configuration.env,
            NATIVE_DEV_HOST: '0.0.0.0',
            [DEV_API_HOST_ENV]: options.host,
          },
  });

  if (result.error !== undefined) {
    return fail(`Could not start ${bin}: ${result.error.message}`, EXIT.unavailable);
  }
  // The CLI's own status, propagated. `?? 1` covers only "killed by a signal",
  // which has no status to report — the one case a status cannot answer, and it
  // is reported as a failure rather than as a success with nothing to show.
  return result.status ?? EXIT.failed;
};

/** Run the planned invocation, or explain why it cannot run here. */
const launch = (options: PlanOptions): number => {
  const planned = planInvocation(options);
  if (!planned.ok) {
    return fail(`${planned.message}\n  ${planned.remedy}`, EXIT.usage);
  }

  let configuration: ReturnType<typeof nativeConfiguration>;
  try {
    configuration = nativeConfiguration(options.mode);
  } catch (error) {
    return fail(String(error), EXIT.usage);
  }

  const report = inspectNative();
  if (!report.ok) {
    process.stderr.write(`${renderNativeReport(report)}\n`);
    // 3, not 1: the work was refused because a prerequisite is absent, which is a
    // different response from "the build ran and failed". See `shared/command.ts`.
    return EXIT.unavailable;
  }

  const bin = resolveWorkspaceBin('tauri', [NATIVE_DIR]);
  if (bin === null) {
    return fail(
      'The pinned Tauri CLI could not be resolved. Run `bun install` from the repository root.',
      EXIT.unavailable,
    );
  }

  const { args, cwd } = planned.invocation;
  const result = spawnSync(bin, [...args, '--config', configuration.config], {
    stdio: 'inherit',
    cwd,
    env: configuration.env,
  });

  if (result.error !== undefined) {
    return fail(`Could not start ${bin}: ${result.error.message}`, EXIT.unavailable);
  }
  // The CLI's own status, propagated. `?? 1` covers only "killed by a signal",
  // which has no status to report.
  return result.status ?? EXIT.failed;
};

const run = async (args: readonly string[]): Promise<number> => {
  if (wantsHelp(args)) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT.ok;
  }
  if (args.length === 0) {
    return fail(`${USAGE}\n`, EXIT.usage);
  }

  const [subcommand, ...rest] = args;

  if (subcommand === 'android' || subcommand === 'ios') {
    const platform = subcommand as MobilePlatform;
    const parsed = parseMobileArgs(platform, rest);
    if (!parsed.ok) {
      return fail(`${parsed.message}\n  ${parsed.remedy}`, EXIT.usage);
    }
    return launchMobile(parsed.options);
  }

  if (subcommand === 'doctor') {
    // `native doctor --platform android` and `native doctor android` are the
    // same request; the second is what the help text shows and the first is what
    // a script writes.
    const platform = rest[0] === '--platform' ? rest[1] : rest[0];
    return doctor(platform);
  }
  if (subcommand !== 'dev' && subcommand !== 'build') {
    return fail(
      `Unknown subcommand "${subcommand}".\n` +
        `  Expected: doctor, dev, build, android, ios.\n` +
        'Run `bun run native:doctor -- --help` for usage.',
      EXIT.usage,
    );
  }

  const parsed = parseNativeArgs([subcommand, ...rest]);
  if (!parsed.ok) {
    return fail(`${parsed.message}\n  ${parsed.remedy}`, EXIT.usage);
  }

  return launch(parsed.options);
};

export const nativeCommand: Command = {
  name: 'native',
  summary: 'Build or run the Tauri desktop app (needs a Rust toolchain)',
  usage: USAGE.split('\n')[0] ?? 'native <doctor|dev|build>',
  run,
};

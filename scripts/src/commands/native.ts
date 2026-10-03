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
import { inspectNative, renderNativeReport } from '../native/doctor.ts';
import {
  NATIVE_DIR,
  type PlanOptions,
  parseNativeArgs,
  planInvocation,
} from '../native/platform.ts';
import type { Command } from '../shared/command.ts';
import { EXIT, fail, wantsHelp } from '../shared/command.ts';
import { resolveWorkspaceBin } from '../shared/tools.ts';

const USAGE = `native <doctor|dev|build> [flags]

Runs the pinned Tauri CLI for apps/frontend/native.

  doctor            report what this host can build, and what it cannot
  dev               tauri dev: the static app plus the shell, on the dev port
  build             tauri build: a release binary and its installer

Flags
  --linux | --macos | --windows    this host, named explicitly
  --platform <name>                the same thing, spelled as a value
  --target <triple>                a Rust target triple, e.g. x86_64-apple-darwin
  --features <a,b>                 cargo features
  --no-bundle                      build the binary without an installer

A platform name resolves to this host's Rust target triple, because the Tauri 2
CLI has no platform flag at all. A platform that is not this one is refused: a
desktop binary is built on its own operating system, and the desktop matrix in
.github/workflows/native.yml has one runner per OS.

Examples
  bun run native:doctor
  bun run native:dev
  bun run native:build -- --no-bundle
  bun run native:build -- --target aarch64-apple-darwin`;

const doctor = (): number => {
  const report = inspectNative();
  process.stdout.write(`${renderNativeReport(report)}\n`);

  return report.ok ? EXIT.ok : EXIT.unavailable;
};

/** Run the planned invocation, or explain why it cannot run here. */
const launch = (options: PlanOptions): number => {
  const planned = planInvocation(options);
  if (!planned.ok) {
    return fail(`${planned.message}\n  ${planned.remedy}`, EXIT.usage);
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
  const result = spawnSync(bin, [...args], { stdio: 'inherit', cwd });

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

  if (subcommand === 'doctor') {
    return doctor();
  }
  if (subcommand !== 'dev' && subcommand !== 'build') {
    return fail(
      `Unknown subcommand "${subcommand}".\n  Expected: doctor, dev, build.\n` +
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

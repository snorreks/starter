// scripts/src/shared/command.ts
//
// The shape every command in this workspace exposes.
//
// One dispatcher, many commands, and each command owns exactly three things:
// parsing argv, rendering help, and choosing an exit code. The work lives in a
// domain module under `scripts/src/<domain>/`.
//
// The split exists so `bun run scripts -- --help` can describe what actually
// exists — the list is built from the same descriptors the dispatcher runs — and
// so a command can be reached from a package.json script, from CI, or from a test
// without any of them re-implementing the argument handling.

export interface Command {
  /** Stable word used on the command line and in `--help`. */
  readonly name: string;
  /** One line, shown in the command list. */
  readonly summary: string;
  /** Usage line, shown by `<command> --help`. */
  readonly usage: string;
  /**
   * Return the process exit code. Commands write to stdout/stderr directly;
   * returning a code keeps them testable without spawning a process.
   */
  run(args: readonly string[]): Promise<number> | number;
}

/**
 * Exit codes, in one place because "exit 3" only means something if it means the
 * same thing everywhere.
 */
export const EXIT = {
  /** The work succeeded. */
  ok: 0,
  /** The work ran and found a problem: a failing guard, a failed check. */
  failed: 1,
  /** The invocation was wrong: an unknown command, flag or target. */
  usage: 2,
  /** A prerequisite for this operation is not available here. */
  unavailable: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Write `message` to stderr and return a code, for the many `return fail(...)`. */
export const fail = (message: string, code: ExitCode = EXIT.failed): ExitCode => {
  process.stderr.write(`${message}\n`);
  return code;
};

/** True when the caller asked for help rather than for work. */
export const wantsHelp = (args: readonly string[]): boolean =>
  args.includes('--help') || args.includes('-h');
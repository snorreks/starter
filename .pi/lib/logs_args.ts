// .pi/lib/logs_args.ts
//
// Translate the agent-facing `read_logs` parameters into argv for `bun run logs`.
//
// This lives outside `.pi/extensions/` for two reasons:
//
//   1. **Pi discovers `.pi/extensions/**` and tries to load every file it finds
//      there as an extension.** A test file or a helper placed in that directory
//      is loaded as an extension, and one that imports `bun:test` fails the load.
//      The directory is executable input, not a source folder.
//   2. This module has no Pi imports at all. That is what makes it testable
//      without a Pi runtime, and it is why the test suite can assert on argv
//      rather than on a constant.

/**
 * Hard cap on returned lines.
 *
 * An agent that asks for "all the logs" and receives a megabyte of NDJSON has
 * lost the thread, and the transcript is now mostly log lines.
 */
export const MAX_LINES = 200;

/** Shapes the tool accepts. Mirrors the TypeBox schema in the extension. */
export interface LogParams {
  app?: 'client' | 'api' | 'all';
  mode?: 'local' | 'staging' | 'production';
  level?: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';
  uid?: string;
  traceId?: string;
  limit?: number;
  errorsOnly?: boolean;
}

/**
 * Build argv for the log CLI.
 *
 * Every flag emitted here must be one `scripts/src/commands/logs.ts` actually
 * parses. A typo is not a crash — it is a flag the CLI ignores, and a model
 * reading "no matching logs" concludes the request never happened.
 */
export const buildArgs = (params: LogParams): string[] => {
  const args = ['run', 'logs'];

  args.push(params.app ?? 'all');
  args.push('--mode', params.mode ?? 'local');

  const level = params.errorsOnly === true ? 'ERROR' : params.level;
  if (level !== undefined) {
    args.push('--level', level);
  }
  if (params.uid !== undefined && params.uid.length > 0) {
    args.push('--uid', params.uid);
  }
  if (params.traceId !== undefined && params.traceId.length > 0) {
    args.push('--trace', params.traceId);
  }

  const limit = params.limit ?? MAX_LINES;
  // Clamped rather than rejected: a model asking for 100000 lines has usually
  // made a mistake, and a bounded answer is more useful than an error.
  args.push('--limit', String(Math.max(1, Math.min(limit, MAX_LINES))));

  return args;
};

/** Recorded alongside the output so the model can see what was actually run. */
export interface LogCallDetails {
  command: string;
  exitCode: number;
  /** True when output was truncated to stay inside the byte budget. */
  truncated: boolean;
  /** Where the full output went, when it went somewhere. */
  artifactPath?: string;
}

// .pi/tests/logs_args.test.ts
//
// The argument builder for the agent-facing log tool.
//
// Lives outside .pi/extensions on purpose: that directory is Pi's discovery input
// and every module in it is loaded as an extension. A test there imports bun:test
// and breaks the extension load.
//
// This is the whole contract: the tool turns a model's parameters into argv for
// `bun run logs`. A wrong flag is not a crash — it is a flag the CLI silently
// ignores, and a model reading "no matching logs" concludes the request never
// happened. That is the specific failure these tests exist to prevent, so they
// check flag *names* against the real CLI rather than just checking the array
// has the right length.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildArgs } from '../lib/logs_args.ts';

const CLI_SOURCE = readFileSync(
  join(import.meta.dirname, '..', '..', 'scripts', 'src', 'lib', 'logs', 'cli.ts'),
  'utf8',
);

/** Flags the CLI actually parses. */
const CLI_FLAGS = new Set(
  [...CLI_SOURCE.matchAll(/'(--[a-z-]+)'/g)]
    .map((match) => match[1])
    .filter((flag): flag is string => flag !== undefined),
);

describe('flags', () => {
  test('the CLI parses every flag this tool can emit', () => {
    // If the CLI renames a flag, this fails rather than the tool silently sending
    // something the CLI ignores.
    const emitted = [
      ...buildArgs({}),
      ...buildArgs({ level: 'ERROR' }),
      ...buildArgs({ uid: 'u1' }),
      ...buildArgs({ traceId: 't1' }),
      ...buildArgs({ limit: 5 }),
    ].filter((arg) => arg.startsWith('--'));

    const unknown = [...new Set(emitted)].filter((flag) => !CLI_FLAGS.has(flag));

    expect(unknown).toEqual([]);
  });

  test('the test found the CLI it thinks it did', () => {
    // If the path were wrong the set would be empty and the test above would
    // vacuously pass. This asserts the fixture is real.
    expect(CLI_FLAGS.size).toBeGreaterThan(5);
    expect(CLI_FLAGS.has('--mode')).toBe(true);
    expect(CLI_FLAGS.has('--limit')).toBe(true);
  });
});

describe('buildArgs', () => {
  test('defaults to all apps in local mode', () => {
    const args = buildArgs({});

    expect(args.slice(0, 2)).toEqual(['run', 'logs']);
    expect(args).toContain('all');
    expect(args[args.indexOf('--mode') + 1]).toBe('local');
  });

  test('passes the requested app and mode through', () => {
    const args = buildArgs({ app: 'api', mode: 'production' });

    expect(args).toContain('api');
    expect(args[args.indexOf('--mode') + 1]).toBe('production');
  });

  test('errorsOnly is shorthand for level ERROR', () => {
    const args = buildArgs({ errorsOnly: true });

    expect(args[args.indexOf('--level') + 1]).toBe('ERROR');
  });

  test('errorsOnly wins over an explicit lower level', () => {
    // Otherwise a model asking for both gets DEBUG and concludes nothing errors.
    const args = buildArgs({ errorsOnly: true, level: 'DEBUG' });

    expect(args[args.indexOf('--level') + 1]).toBe('ERROR');
    expect(args.filter((arg) => arg === '--level')).toHaveLength(1);
  });

  test('an explicit level is passed when errorsOnly is absent', () => {
    const args = buildArgs({ level: 'WARNING' });

    expect(args[args.indexOf('--level') + 1]).toBe('WARNING');
  });

  test('omits --level when neither is given', () => {
    expect(buildArgs({})).not.toContain('--level');
  });

  test('clamps the limit rather than refusing it', () => {
    // A model asking for 100000 lines has made a mistake; a bounded answer is
    // more useful to it than an error, and an unbounded one would bury the
    // conversation in log output.
    const args = buildArgs({ limit: 100_000 });

    const limit = Number(args[args.indexOf('--limit') + 1]);
    expect(limit).toBeLessThanOrEqual(200);
  });

  test('clamps a limit of zero to something valid', () => {
    const args = buildArgs({ limit: 0 });

    expect(Number(args[args.indexOf('--limit') + 1])).toBeGreaterThan(0);
  });

  test('keeps a reasonable limit unchanged', () => {
    const args = buildArgs({ limit: 25 });

    expect(args[args.indexOf('--limit') + 1]).toBe('25');
  });

  test('always sends a limit, even when none is requested', () => {
    // Unbounded log output is the failure mode this tool exists to avoid.
    expect(buildArgs({})).toContain('--limit');
  });

  test('omits --uid and --trace when not requested', () => {
    const args = buildArgs({});

    expect(args).not.toContain('--uid');
    expect(args).not.toContain('--trace');
  });

  test('omits an empty filter rather than sending it', () => {
    // `--uid ""` would filter for the empty string and match nothing, and read
    // like a real result.
    const args = buildArgs({ uid: '', traceId: '' });

    expect(args).not.toContain('--uid');
    expect(args).not.toContain('--trace');
  });

  test('passes a non-empty filter through', () => {
    const args = buildArgs({ uid: 'user_1', traceId: 'trace_1' });

    expect(args[args.indexOf('--uid') + 1]).toBe('user_1');
    expect(args[args.indexOf('--trace') + 1]).toBe('trace_1');
  });

  test('never passes --follow', () => {
    // A tool call that never returns blocks the agent indefinitely.
    expect(buildArgs({ mode: 'production' })).not.toContain('--follow');
  });

  test('every flag is followed by a value', () => {
    // A trailing flag with no argument is how a CLI silently does nothing.
    const args = buildArgs({
      app: 'client',
      mode: 'staging',
      level: 'INFO',
      uid: 'u',
      traceId: 't',
      limit: 10,
    });

    for (const [index, arg] of args.entries()) {
      if (!arg.startsWith('--')) {
        continue;
      }
      const next = args[index + 1];
      expect(next, `${arg} has no value`).toBeDefined();
      expect(next?.startsWith('--')).toBe(false);
    }
  });
});

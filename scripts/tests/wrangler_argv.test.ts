// scripts/tests/wrangler_argv.test.ts
//
// Every flag this repository passes to the pinned Wrangler, checked against that
// CLI's own help output.
//
// Why this file exists: `preflight` read installed secrets with
// `wrangler secret list --name X --json`, and wrangler 4.142.0 has no `--json` flag
// on that subcommand — it has `--format [choices: "json", "pretty"]`. Clap printed
// usage and exited non-zero, so the check reported "this token cannot list them" on
// every run, including the runs where the secrets were installed and wrangler
// answered them.
//
// It survived because every other test injects a fake `run` and asserts the argv
// against a copy of the argv. Asserting that a string equals itself proves the
// string did not change, not that any CLI accepts it. This test asks the real
// binary.
//
// It is a help-text check, not a behaviour check: no credential, no network, and no
// call that mutates anything. `--help` is resolved from the workspace binary
// (`node_modules/.bin/wrangler`), which is the pinned version in `bun.lock`.

import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretListArgv } from '../src/deploy/preflight.ts';
import { REPO_ROOT } from '../src/shared/paths.ts';

/** The pinned wrangler, resolved the way the tooling resolves it. */
const WRANGLER = join(REPO_ROOT, 'scripts/node_modules/.bin/wrangler');

/** Every `--flag` and `-f` in an argv, without their values. */
const flagsOf = (args: readonly string[]): string[] =>
  args.filter((arg, index) => index > 0 && arg.startsWith('-'));

/** The option names a subcommand's help actually offers. */
const offeredFlags = (help: string): Set<string> => {
  const found = new Set<string>();
  for (const match of help.matchAll(/(?:^|\s)(--[a-z][a-z-]*|[a-zA-Z], --[a-z][a-z-]*)/g)) {
    const token = match[1] ?? '';
    const long = token.includes(',') ? (token.split(', --')[1] ?? '') : token;
    if (long.startsWith('--')) {
      found.add(long);
    }
  }
  return found;
};

const helpFor = (args: readonly string[]): string => {
  const result = Bun.spawnSync([WRANGLER, ...args, '--help'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return `${result.stdout.toString()}\n${result.stderr.toString()}`;
};

describe('the flags this repository passes to the pinned wrangler', () => {
  test('the pinned wrangler is the one in the lockfile, not a registry copy', () => {
    expect(existsSync(WRANGLER)).toBe(true);

    const lock = readFileSync(join(REPO_ROOT, 'bun.lock'), 'utf8');
    const pinned = /^\s*"wrangler": "(\d+\.\d+\.\d+)",$/m.exec(lock)?.[1];

    expect(pinned).toBeDefined();
    if (pinned === undefined) {
      return;
    }
    const reported = Bun.spawnSync([WRANGLER, '--version'], { cwd: REPO_ROOT })
      .stdout.toString()
      .trim();
    expect(reported).toContain(pinned);
  });

  test('every flag `secret list` is given exists in that subcommand', () => {
    const argv = secretListArgv('starter-demo-web-staging', 'staging');
    const help = helpFor(['secret', 'list']);
    const offered = offeredFlags(help);

    // The bug this file exists for, named rather than described.
    expect(argv).not.toContain('--json');

    for (const flag of flagsOf(argv)) {
      expect(offered.has(flag)).toBe(true);
    }
  });

  test('secret reads name the exact Worker without legacy environment suffixing', () => {
    const argv = secretListArgv('starter-demo-web-staging', 'staging');
    expect(argv).not.toContain('--env');
    expect(argv[argv.indexOf('--name') + 1]).toBe('starter-demo-web-staging');
  });

  test('deployment provenance uses an offered flag, not the invented --meta', () => {
    const offered = offeredFlags(helpFor(['deploy']));
    expect(offered.has('--message')).toBe(true);
    expect(offered.has('--meta')).toBe(false);
  });

  test('a flag the CLI does not offer would be visible here and nowhere else', () => {
    // The control: an invented flag is not in the help, so the loop above would
    // fail on it. Without this assertion the test could pass by offering nothing.
    const offered = offeredFlags(helpFor(['secret', 'list']));

    expect(offered.has('--format')).toBe(true);
    expect(offered.size).toBeGreaterThan(3);
    expect(offered.has('--json')).toBe(false);
  });
});

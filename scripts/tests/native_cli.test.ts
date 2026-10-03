// scripts/tests/native_cli.test.ts
//
// The native command's decisions, asserted without a Rust toolchain.
//
// The property under test is the one the snapshot's launcher lacked: every flag is
// either understood and mapped to a real subcommand, or refused with the flags that
// do exist. Nothing is forwarded to the CLI on the chance that it will do something
// sensible with it.
//
// The second property is the working directory and the resolution rule. A Tauri CLI
// run from the repository root does not find `tauri.conf.json`, and `bunx tauri`
// runs whatever the registry serves that day — so both are pinned here rather than
// left to a build to discover.

import { describe, expect, test } from 'bun:test';
import { nativeCommand } from '../src/commands/native.ts';
import {
  hostPlatform,
  hostTriple,
  NATIVE_DIR,
  parseNativeArgs,
  planInvocation,
  TARGET_TRIPLES,
} from '../src/native/platform.ts';

const parse = (args: string[]) => {
  const result = parseNativeArgs(args);
  if (!result.ok) {
    throw new Error(`expected ${args.join(' ')} to parse`);
  }
  return result.options;
};

describe('the argv the Tauri CLI receives', () => {
  test('a build is `tauri build` in src-tauri', () => {
    const planned = planInvocation(parse(['build']));

    expect(planned.ok).toBe(true);
    if (!planned.ok) {
      return;
    }
    expect(planned.invocation.args).toEqual(['build']);
    expect(planned.invocation.cwd).toBe(`${NATIVE_DIR}/src-tauri`);
  });

  test("a platform name becomes this host's target triple", () => {
    // Not a pass-through. `tauri build --linux` is a usage error — the Tauri 2 CLI
    // has no platform flag at all — and this is the test that caught that, by
    // running the real CLI and reading its own refusal rather than assuming.
    const byFlag = planInvocation(parse(['build', '--platform', hostPlatform()]));
    const byShorthand = planInvocation(parse(['build', `--${hostPlatform()}`]));

    expect(byFlag.ok && byFlag.invocation.args).toEqual(['build', '--target', hostTriple()]);
    expect(byShorthand.ok && byShorthand.invocation.args).toEqual(
      byFlag.ok && byFlag.invocation.args,
    );
  });

  test('a platform this host is not, is refused with the runner to use instead', () => {
    const elsewhere = hostPlatform() === 'linux' ? 'windows' : 'linux';
    const planned = planInvocation(parse(['build', '--platform', elsewhere]));

    expect(planned.ok).toBe(false);
    if (planned.ok) {
      return;
    }
    expect(planned.message).toContain(elsewhere);
    expect(planned.remedy).toContain('native.yml');
  });

  test('an explicit target cannot bypass the cross-host platform refusal', () => {
    const elsewhere = hostPlatform() === 'linux' ? 'windows' : 'linux';
    const target = elsewhere === 'windows' ? 'x86_64-pc-windows-msvc' : 'x86_64-unknown-linux-gnu';
    for (const mode of ['dev', 'build']) {
      const planned = planInvocation(parse([mode, '--platform', elsewhere, '--target', target]));
      expect(planned.ok).toBe(false);
      if (!planned.ok) {
        expect(planned.message).toContain('cannot be built on this host');
      }
    }
  });

  test('a Rust target triple is passed through unchanged', () => {
    const planned = planInvocation(parse(['build', '--target', 'aarch64-apple-darwin']));

    expect(planned.ok && planned.invocation.args).toEqual([
      'build',
      '--target',
      'aarch64-apple-darwin',
    ]);
  });

  test('a platform name is refused in --target, which is the whole point', () => {
    // `tauri build --target windows` is not a subcommand: the failure used to
    // arrive as a CLI usage error, several steps from the actual mistake.
    const planned = planInvocation(parse(['build', '--target', 'windows']));

    expect(planned.ok).toBe(false);
    if (planned.ok) {
      return;
    }
    expect(planned.message).toContain('target triple');
    expect(planned.remedy).toContain('x86_64-unknown-linux-gnu');
  });

  test('a triple and a platform that disagree are refused', () => {
    const elsewhere =
      hostPlatform() === 'windows' ? 'aarch64-unknown-linux-gnu' : 'x86_64-pc-windows-msvc';
    const planned = planInvocation(
      parse(['build', '--platform', hostPlatform(), '--target', elsewhere]),
    );

    expect(planned.ok).toBe(false);
    if (!planned.ok) {
      expect(planned.message).toContain('disagree');
    }
  });

  test("a triple and this host's platform may be given together", () => {
    // The explicit form, for the one case that needs it: an Apple Silicon build on
    // an Intel Mac, or the reverse. Both are real, and both are still one machine.
    const planned = planInvocation(
      parse(['build', '--platform', hostPlatform(), '--target', hostTriple()]),
    );

    expect(planned.ok && planned.invocation.args).toEqual(['build', '--target', hostTriple()]);
  });

  test('an unknown flag is refused with the flags that exist', () => {
    // The snapshot forwarded these to the CLI, so `--tauri-deb` was a silent
    // no-op and `--flag` was somebody else's typo.
    const result = parseNativeArgs(['build', '--tauri-deb']);

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.message).toContain('--tauri-deb');
    expect(result.remedy).toContain('--no-bundle');
  });

  test('a stray argument is refused rather than ignored', () => {
    const result = parseNativeArgs(['build', 'windows']);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('windows');
    }
  });

  test('features and --no-bundle reach cargo and the bundler', () => {
    const planned = planInvocation(
      parse(['build', '--features', 'custom-protocol,extra', '--no-bundle']),
    );

    expect(planned.ok && planned.invocation.args).toEqual([
      'build',
      '--features',
      'custom-protocol,extra',
      '--no-bundle',
    ]);
  });

  test('the accepted triple list is closed', () => {
    // A pattern would accept a triple nobody has a linker for, and the failure
    // would name the toolchain rather than the argument.
    expect(TARGET_TRIPLES).toContain('x86_64-unknown-linux-gnu');
    expect(planInvocation(parse(['build', '--target', 'x86_64-unknown-freebsd'])).ok).toBe(false);
  });
});

describe('the command itself', () => {
  test('it is registered under a name the dispatcher can find', () => {
    expect(nativeCommand.name).toBe('native');
    expect(nativeCommand.summary.length).toBeGreaterThan(0);
  });

  test('help prints usage and succeeds', async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      expect(await nativeCommand.run(['--help'])).toBe(0);
    } finally {
      process.stdout.write = original;
    }

    expect(written.join('')).toContain('native <doctor|dev|build>');
  });

  test('no subcommand is a usage error, not a no-op', async () => {
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(await nativeCommand.run([])).toBe(2);
      expect(await nativeCommand.run(['android'])).toBe(2);
    } finally {
      process.stderr.write = original;
    }
  });

  test('a bad flag is refused before anything is launched', async () => {
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(await nativeCommand.run(['build', '--target', 'windows'])).toBe(2);
    } finally {
      process.stderr.write = original;
    }
  });
});

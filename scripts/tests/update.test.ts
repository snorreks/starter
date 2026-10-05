import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBounded, runBoundedSync } from '../src/shared/run_bounded.ts';
import { bunPinEdits, parseUpdateArgs, runUpdate } from '../src/update/update.ts';

const roots: string[] = [];
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-update-'));
  roots.push(root);
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(
    join(root, 'config/toolchain.json'),
    '{"bun":"1.4.2","playwright":{"browsers":["chromium"]}}',
  );
  writeFileSync(join(root, '.bun-version'), '1.4.2\n');
  writeFileSync(
    join(root, '.github/workflows/ci.yml'),
    "env:\n  BUN_VERSION: '1.4.2'\nsteps:\n  - uses: oven-sh/setup-bun@fixture\n",
  );
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('only selected lanes run, exclusions work, and typos never mean all', () => {
  expect(parseUpdateArgs([]).lanes).toEqual(['nix', 'bun', 'packages']);
  expect(parseUpdateArgs(['--packages']).lanes).toEqual(['packages']);
  expect(parseUpdateArgs(['--nix', '--bun']).lanes).toEqual(['nix', 'bun']);
  expect(parseUpdateArgs(['--no-nix']).lanes).toEqual(['bun', 'packages']);
  for (const args of [
    ['--packges'],
    ['--yes=false'],
    ['--bun-version'],
    ['--bun', '--no-bun'],
    ['--no-bun', '--no-nix', '--no-packages'],
  ]) {
    expect(() => parseUpdateArgs(args)).toThrow();
  }
});

test('a preview cannot spawn a process, fetch, or write a pin', async () => {
  const root = fixture();
  const before = readFileSync(join(root, 'config/toolchain.json'), 'utf8');
  const forbidden = (): never => {
    throw new Error('Preview performed work');
  };
  expect(
    await runUpdate(parseUpdateArgs([]), {
      root,
      run: forbidden,
      fetch: Object.assign(forbidden, { preconnect: () => {} }),
      write: () => {},
    }),
  ).toBe(0);
  expect(readFileSync(join(root, 'config/toolchain.json'), 'utf8')).toBe(before);
});

test('new setup-bun workflows are reconciled rather than omitted from the mirror list', () => {
  const root = fixture();
  writeFileSync(
    join(root, '.github/workflows/extra.yml'),
    "BUN_VERSION: '1.4.2'\nuses: oven-sh/setup-bun@fixture\n",
  );
  const changes = bunPinEdits({ root, version: '1.4.3', sources: {} });
  expect(changes.get(join(root, '.github/workflows/extra.yml'))).toContain("BUN_VERSION: '1.4.3'");
  expect(readFileSync(join(root, '.bun-version'), 'utf8')).toBe('1.4.2\n');
});

test('a missing mirror refuses before any pin is written', () => {
  const root = fixture();
  writeFileSync(join(root, '.github/workflows/extra.yml'), 'uses: oven-sh/setup-bun@fixture\n');
  expect(() => bunPinEdits({ root, version: '1.4.3', sources: {} })).toThrow('no BUN_VERSION');
  expect(readFileSync(join(root, '.bun-version'), 'utf8')).toBe('1.4.2\n');
});

test('packages update all workspaces exactly without requiring Nix', async () => {
  const calls: string[][] = [];
  const root = fixture();
  const code = await runUpdate(parseUpdateArgs(['--packages', '--yes', '--verify']), {
    root,
    write: () => {},
    run: async (options) => {
      calls.push([options.command, ...options.args]);
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  expect(code).toBe(0);
  expect(calls.map((call) => call.slice(1))).toEqual([
    ['update', '--recursive', '--latest', '--exact'],
    ['run', 'guard'],
    ['run', 'lint'],
    ['run', 'typecheck'],
    ['run', 'test'],
  ]);
});

test('a missing requested Nix prerequisite stops before mutating a file', async () => {
  const root = fixture();
  let calls = 0;
  const code = await runUpdate(parseUpdateArgs(['--yes']), {
    root,
    write: () => {},
    run: async () => {
      calls += 1;
      return { code: 1, stdout: '', stderr: 'missing nix' };
    },
  });
  expect(code).toBe(3);
  expect(calls).toBe(1);
  expect(readFileSync(join(root, '.bun-version'), 'utf8')).toBe('1.4.2\n');
});

test('all lanes build the new Bun before using it to regenerate the lockfile', async () => {
  const root = fixture();
  const calls: string[][] = [];
  const code = await runUpdate(
    parseUpdateArgs(['--nix', '--packages', '--bun-version', '1.4.3', '--yes']),
    {
      root,
      write: () => {},
      run: async (options) => {
        calls.push([options.command, ...options.args]);
        let stdout = '';
        if (options.args.includes('prefetch-file')) {
          stdout = JSON.stringify({ hash: `sha256-${'A'.repeat(43)}=` });
        }
        if (options.args[0] === 'build') {
          stdout = '/nix/store/fixture-bun\n';
        }
        if (options.command.endsWith('/bin/bun') && options.args[0] === '--version') {
          stdout = '1.4.3\n';
        }
        return { code: 0, stdout, stderr: '' };
      },
    },
  );
  expect(code).toBe(0);
  expect(calls[1]?.slice(1)).toEqual(['flake', 'update']);
  expect(calls.filter((call) => call.includes('prefetch-file'))).toHaveLength(3);
  expect(calls.find((call) => call.includes('--recursive'))?.[0]).toBe(
    '/nix/store/fixture-bun/bin/bun',
  );
  expect(readFileSync(join(root, '.bun-version'), 'utf8')).toBe('1.4.3\n');
});

test('a failed update stops instead of running later verification', async () => {
  const root = fixture();
  let calls = 0;
  const code = await runUpdate(parseUpdateArgs(['--packages', '--yes', '--verify']), {
    root,
    write: () => {},
    run: async () => {
      calls += 1;
      return { code: 7, stdout: '', stderr: 'registry failure' };
    },
  });
  expect(code).toBe(1);
  expect(calls).toBe(1);
});

test('a real subprocess that never exits is stopped by an injected time budget', async () => {
  const result = await runBounded({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: fixture(),
    timeoutMs: 100,
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('time budget');
});

test('the sync CLI adapter preserves stdin and exit status without putting a value in argv', () => {
  const result = runBoundedSync({
    command: process.execPath,
    args: [
      '-e',
      'const fs=require("node:fs"); console.log(require("node:crypto").createHash("sha256").update(fs.readFileSync(0)).digest("hex")); console.log(process.argv.join(" ")); process.exit(7)',
    ],
    cwd: fixture(),
    input: 'fixture-secret\n',
    timeoutMs: 1000,
  });
  expect(result.code).toBe(7);
  expect(result.stdout).toContain(createHash('sha256').update('fixture-secret\n').digest('hex'));
  // The child prints its argv; input bytes were not an argument.
  expect(result.stdout).not.toContain('fixture-secret');
});

test('the sync CLI adapter bounds a launcher exiting before its child', () => {
  const result = runBoundedSync({
    command: process.execPath,
    args: [
      '-e',
      'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"}); process.exit(0)',
    ],
    cwd: fixture(),
    timeoutMs: 150,
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('time budget');
});

test('a launcher exiting before its child cannot hold the pipes past the deadline', async () => {
  const result = await runBounded({
    command: process.execPath,
    args: [
      '-e',
      'require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"inherit"}); process.exit(0)',
    ],
    cwd: fixture(),
    timeoutMs: 150,
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('time budget');
});

test('cancellation stops a real process rather than only abandoning its result', async () => {
  const result = await runBounded({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: fixture(),
    signal: AbortSignal.timeout(100),
  });
  expect(result.code).toBe(1);
  expect(result.stderr).toContain('cancelled');
});

test('a real output flood is stopped with bounded retained bytes', async () => {
  const result = await runBounded({
    command: process.execPath,
    args: ['-e', 'setInterval(() => process.stdout.write("x".repeat(4096)), 1)'],
    cwd: fixture(),
    maxBytes: 1000,
    timeoutMs: 2000,
  });
  expect(result.code).toBe(1);
  expect(result.stdout.length).toBeLessThanOrEqual(1000);
  expect(result.stderr).toContain('output budget');
});

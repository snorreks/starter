import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBounded, runBoundedSync } from '../src/shared/run_bounded.ts';
import {
  bunPinEdits,
  parseUpdateArgs,
  readPinnedRanges,
  restorePinnedRanges,
  runUpdate,
  verifyPinnedRanges,
} from '../src/update/update.ts';

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
    // Resolution and writing first, with nothing installed yet: the install below
    // is the first command that can run a lifecycle script.
    ['update', '--recursive', '--latest', '--exact', '--lockfile-only'],
    ['install'],
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

/**
 * A workspace carrying the two pins this repository actually declares.
 *
 * `.syncpackrc` and a real `workspaces` list, because the failure under test is
 * discovered from those two files — a fixture that hardcoded a package list would
 * pass against a lane that read nothing.
 */
const pinnedFixture = (
  syncpackrc: unknown = {
    semverGroups: [
      { label: 'TypeScript is pinned', packages: ['typescript'], range: '6.0.3' },
      { label: 'Biome is pinned', packages: ['@biomejs/biome'], range: '2.5.13' },
    ],
  },
): string => {
  const root = fixture();
  writeFileSync(join(root, '.syncpackrc'), `${JSON.stringify(syncpackrc, null, 2)}\n`);
  mkdirSync(join(root, 'apps/frontend/client'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify(
      {
        name: 'root',
        private: true,
        workspaces: ['apps/frontend/*', 'scripts'],
        dependencies: { unpinned: '1.0.0' },
        devDependencies: { typescript: '6.0.3', '@biomejs/biome': '2.5.13' },
      },
      null,
      2,
    )}\n`,
  );
  for (const [dir, name] of [
    ['apps/frontend/client', '@starter/client'],
    ['scripts', '@starter/scripts'],
  ]) {
    writeFileSync(
      join(root, dir, 'package.json'),
      `${JSON.stringify({ name, private: true, devDependencies: { typescript: '6.0.3' } }, null, 2)}\n`,
    );
  }
  writeFileSync(
    join(root, 'bun.lock'),
    JSON.stringify({
      packages: {
        typescript: ['typescript@6.0.3', '', {}, 'sha512-x'],
        '@biomejs/biome': ['@biomejs/biome@2.5.13', '', {}, 'sha512-y'],
      },
    }),
  );
  return root;
};

const declaredTypeScript = (root: string, dir = 'package.json'): string | undefined =>
  (
    JSON.parse(readFileSync(join(root, dir), 'utf8')) as {
      devDependencies?: Record<string, string>;
    }
  ).devDependencies?.typescript;

test('a pinned package resolved to a new major is restored before anything installs', async () => {
  const root = pinnedFixture();
  const calls: string[][] = [];
  const code = await runUpdate(parseUpdateArgs(['--packages', '--yes']), {
    root,
    write: () => {},
    run: async (options) => {
      calls.push([options.command, ...options.args]);
      // `--latest` writes the newest major into every manifest. The range at the
      // time the install runs is what determines the tree, so the restore has to
      // have happened already.
      if (options.args[0] === 'update') {
        for (const dir of [
          'package.json',
          'apps/frontend/client/package.json',
          'scripts/package.json',
        ]) {
          const manifest = JSON.parse(readFileSync(join(root, dir), 'utf8')) as {
            devDependencies: Record<string, string>;
          };
          manifest.devDependencies.typescript = '7.0.2';
          writeFileSync(join(root, dir), `${JSON.stringify(manifest, null, 2)}\n`);
        }
      }
      if (options.args[0] === 'install') {
        for (const path of [
          'package.json',
          'apps/frontend/client/package.json',
          'scripts/package.json',
        ]) {
          expect(declaredTypeScript(root, path)).toBe('6.0.3');
        }
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  expect(code).toBe(0);
  expect(declaredTypeScript(root)).toBe('6.0.3');
  expect(declaredTypeScript(root, 'apps/frontend/client/package.json')).toBe('6.0.3');
  expect(declaredTypeScript(root, 'scripts/package.json')).toBe('6.0.3');
  // The install is the boundary: nothing may install before the pins are back.
  const installAt = calls.findIndex((call) => call.includes('install'));
  const updateAt = calls.findIndex((call) => call.includes('--recursive'));
  expect(updateAt).toBe(0);
  expect(installAt).toBe(1);
});

test('an unpinned package is left on the version the update resolved', () => {
  const root = pinnedFixture();
  const path = join(root, 'package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.dependencies.unpinned = '2.0.0';
  manifest.devDependencies.typescript = '7.0.2';
  writeFileSync(path, JSON.stringify(manifest));
  const restored = restorePinnedRanges({ root, pins: readPinnedRanges(root) });
  expect(restored.map((entry) => entry.name)).toEqual(['typescript']);
  expect(JSON.parse(readFileSync(path, 'utf8')).dependencies.unpinned).toBe('2.0.0');
});

test('a pin that the install puts back off the pin is reported with both versions', async () => {
  const root = pinnedFixture();
  const messages: string[] = [];
  const code = await runUpdate(parseUpdateArgs(['--packages', '--yes']), {
    root,
    write: (text) => messages.push(text),
    run: async (options) => {
      if (options.args[0] === 'install') {
        // `bun install` rewrites a range it considers non-canonical.
        const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
          devDependencies: Record<string, string>;
        };
        manifest.devDependencies.typescript = '7.0.2';
        writeFileSync(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      }
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  expect(code).toBe(1);
  const said = messages.join('\n');
  expect(said).toContain('typescript 7.0.2');
  expect(said).toContain('6.0.3');
});

test('a lockfile that resolves a pinned package off its pin is reported, not installed quietly', () => {
  const root = pinnedFixture();
  writeFileSync(
    join(root, 'bun.lock'),
    `${JSON.stringify({ packages: { typescript: ['typescript@7.0.2', '', {}, 'sha512-x'] } })}\n`,
  );
  expect(() => verifyPinnedRanges({ root, pins: readPinnedRanges(root) })).toThrow(
    'bun.lock resolves typescript to 7.0.2, not the pinned 6.0.3',
  );
});

test('a lockfile holding the pin reports nothing', () => {
  const root = pinnedFixture();
  writeFileSync(
    join(root, 'bun.lock'),
    `${JSON.stringify({ packages: { typescript: ['typescript@6.0.3', '', {}, 'sha512-x'], '@biomejs/biome': ['@biomejs/biome@2.5.13', '', {}, 'sha512-y'] } })}\n`,
  );
  expect(() => verifyPinnedRanges({ root, pins: readPinnedRanges(root) })).not.toThrow();
});

test('a syncpackrc declaring no groups refuses rather than silently pinning nothing', () => {
  expect(() => readPinnedRanges(pinnedFixture({ dev: true }))).toThrow('no semverGroups');
});

test('a syncpackrc pinning one package to two ranges refuses', () => {
  const root = pinnedFixture({
    semverGroups: [
      { packages: ['typescript'], range: '6.0.3' },
      { packages: ['typescript'], range: '7.0.2' },
    ],
  });
  expect(() => readPinnedRanges(root)).toThrow('cannot hold two ranges');
});

test('a repository with no syncpackrc still updates every workspace', async () => {
  const root = pinnedFixture();
  rmSync(join(root, '.syncpackrc'));
  const commands: string[][] = [];
  const code = await runUpdate(parseUpdateArgs(['--packages', '--yes']), {
    root,
    write: () => {},
    run: async (options) => {
      expect(options.command).toBe(process.execPath);
      expect(options.cwd).toBe(root);
      commands.push([...options.args]);
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  expect(code).toBe(0);
  expect(commands).toEqual([
    ['update', '--recursive', '--latest', '--exact', '--lockfile-only'],
    ['install'],
    ['run', 'guard'],
  ]);
});

for (const missingLockfile of [false, true]) {
  test(`an exact pin with ${missingLockfile ? 'no lockfile' : 'no resolution'} is reported`, () => {
    const root = pinnedFixture();
    if (missingLockfile) {
      rmSync(join(root, 'bun.lock'));
    } else {
      writeFileSync(join(root, 'bun.lock'), '{"packages":{}}');
    }
    expect(() => verifyPinnedRanges({ root, pins: readPinnedRanges(root) })).toThrow(
      'bun.lock has no resolution for typescript, expected the pinned 6.0.3',
    );
  });
}

test('a peer dependency is restored and verified against its pin', () => {
  const root = pinnedFixture();
  const path = join(root, 'scripts/package.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  Reflect.deleteProperty(manifest.devDependencies, 'typescript');
  manifest.peerDependencies = { typescript: '7.0.2' };
  writeFileSync(path, JSON.stringify(manifest));
  const pins = readPinnedRanges(root);
  expect(() => verifyPinnedRanges({ root, pins })).toThrow('typescript 7.0.2');
  expect(restorePinnedRanges({ root, pins })).toEqual([
    { path: 'scripts/package.json', name: 'typescript', from: '7.0.2', to: '6.0.3' },
  ]);
  expect(JSON.parse(readFileSync(path, 'utf8')).peerDependencies.typescript).toBe('6.0.3');
  expect(() => verifyPinnedRanges({ root, pins })).not.toThrow();
});

test('a range pin does not require an exact lockfile resolution', () => {
  const root = pinnedFixture({ semverGroups: [{ packages: ['typescript'], range: '^6.0.3' }] });
  const pins = readPinnedRanges(root);
  restorePinnedRanges({ root, pins });
  rmSync(join(root, 'bun.lock'));
  expect(() => verifyPinnedRanges({ root, pins })).not.toThrow();
});

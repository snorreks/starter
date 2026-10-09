import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots: string[] = [];
const source = fileURLToPath(new URL('../src/hooks/pre_commit.ts', import.meta.url));
const installer = fileURLToPath(new URL('../src/hooks/install.ts', import.meta.url));
const git = (root: string, args: string[]) => {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 10_000 });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout;
};
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'starter hook '));
  roots.push(root);
  git(root, ['init', '-q']);
  git(root, ['config', 'user.email', 'fixture@example.test']);
  git(root, ['config', 'user.name', 'Fixture']);
  mkdirSync(join(root, 'node_modules/.bin'), { recursive: true });
  symlinkSync(
    fileURLToPath(new URL('../../node_modules/.bin/biome', import.meta.url)),
    join(root, 'node_modules/.bin/biome'),
  );
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  writeFileSync(
    join(root, 'biome.json'),
    JSON.stringify({ formatter: { indentStyle: 'space' }, files: { ignoreUnknown: true } }),
  );
  mkdirSync(join(root, '.moon/hooks'), { recursive: true });
  copyFileSync(
    fileURLToPath(new URL('../../.moon/hooks/pre-commit', import.meta.url)),
    join(root, '.moon/hooks/pre-commit'),
  );
  chmodSync(join(root, '.moon/hooks/pre-commit'), 0o755);
  mkdirSync(join(root, 'scripts/src/hooks'), { recursive: true });
  writeFileSync(join(root, 'scripts/src/hooks/pre_commit.ts'), 'process.exit(23);\n');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { 'pre-commit': 'bun scripts/src/hooks/pre_commit.ts' } }),
  );
  writeFileSync(join(root, 'file with spaces.ts'), 'export const value = 1;\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'fixture']);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('hooks are isolated to bootstrapped worktrees and run the active worktree revision', () => {
  const root = fixture();
  const linked = join(root, 'linked tree');
  git(root, ['worktree', 'add', '-qb', 'linked', linked]);
  writeFileSync(
    join(linked, 'scripts/src/hooks/pre_commit.ts'),
    "console.error('linked hook: ' + process.cwd()); process.exit(29);\n",
  );
  git(linked, ['add', 'scripts/src/hooks/pre_commit.ts']);
  // A newly created worktree has an independent hook configuration until setup.
  expect(spawnSync('git', ['commit', '-qm', 'older tree'], { cwd: linked }).status).toBe(0);
  const result = spawnSync(process.execPath, [installer], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(0);
  writeFileSync(
    join(linked, 'scripts/src/hooks/pre_commit.ts'),
    "console.error('linked hook: ' + process.cwd()); process.exit(30);\n",
  );
  git(linked, ['add', 'scripts/src/hooks/pre_commit.ts']);
  expect(spawnSync('git', ['commit', '-qm', 'still unbootstrapped'], { cwd: linked }).status).toBe(
    0,
  );
  writeFileSync(
    join(linked, 'scripts/src/hooks/pre_commit.ts'),
    "console.error('linked hook: ' + process.cwd()); process.exit(31);\n",
  );
  git(linked, ['add', 'scripts/src/hooks/pre_commit.ts']);
  expect(spawnSync(process.execPath, [installer], { cwd: linked, encoding: 'utf8' }).status).toBe(
    0,
  );
  writeFileSync(
    join(linked, 'scripts/src/hooks/pre_commit.ts'),
    "console.error('linked hook: ' + process.cwd()); process.exit(32);\n",
  );
  git(linked, ['add', 'scripts/src/hooks/pre_commit.ts']);
  const commit = spawnSync('git', ['commit', '-qm', 'blocked'], { cwd: linked, encoding: 'utf8' });
  expect(commit.status).toBe(1);
  expect(commit.stderr).toContain(`linked hook: ${linked}`);
  expect(git(root, ['config', '--worktree', '--get', 'core.hooksPath']).trim()).toBe('.moon/hooks');
  expect(
    spawnSync('git', ['config', '--local', '--get', 'core.hooksPath'], { cwd: root }).status,
  ).toBe(1);
  expect(git(linked, ['config', '--worktree', '--get', 'core.hooksPath']).trim()).toBe(
    '.moon/hooks',
  );
  expect(
    spawnSync('git', ['config', '--local', '--get', 'extensions.worktreeConfig'], {
      cwd: root,
      encoding: 'utf8',
    }).status,
  ).toBe(0);
  rmSync(join(linked, '.moon/hooks/pre-commit'));
  expect(spawnSync('git', ['commit', '-qm', 'without hook file'], { cwd: linked }).status).toBe(0);
});

test('hook installation refuses to replace another hook manager', () => {
  const root = fixture();
  git(root, ['config', 'core.hooksPath', '.husky']);
  const result = spawnSync(process.execPath, [installer], { cwd: root, encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('.husky');
  expect(git(root, ['config', '--get', 'core.hooksPath']).trim()).toBe('.husky');
});

test('staged lint inspects the index and preserves partial staging on failure', () => {
  const root = fixture();
  mkdirSync(join(root, 'scripts/src'), { recursive: true });
  const path = 'scripts/src/file with spaces.ts';
  writeFileSync(join(root, path), 'export const value=2\n');
  git(root, ['add', '--', path]);
  writeFileSync(join(root, path), 'export const value = 3;\n');
  const index = git(root, ['show', `:${path}`]);
  const result = spawnSync(process.execPath, [source], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr + result.stdout).toContain('file with spaces.ts');
  expect(git(root, ['show', `:${path}`])).toBe(index);
  expect(readFileSync(join(root, path), 'utf8')).toBe('export const value = 3;\n');
});

test('a staged plaintext environment is rejected without printing its value', () => {
  const root = fixture();
  writeFileSync(join(root, '.env.production'), 'TOKEN=private-fixture-value\n');
  git(root, ['add', '-f', '.env.production']);
  const result = spawnSync(process.execPath, [source], { cwd: root, encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('.env.production');
  expect(result.stderr + result.stdout).not.toContain('private-fixture-value');
});

test('plaintext staged at an encrypted path cannot be hidden by encrypted working contents', () => {
  const root = fixture();
  mkdirSync(join(root, 'secrets'));
  writeFileSync(join(root, 'secrets/staging.enc.env'), 'TOKEN=private-fixture-value\n');
  git(root, ['add', 'secrets/staging.enc.env']);
  writeFileSync(
    join(root, 'secrets/staging.enc.env'),
    'TOKEN=ENC[AES256_GCM,data:fixture]\nsops_mac=ENC[AES256_GCM,data:fixture]\n',
  );
  const result = spawnSync(process.execPath, [source], { cwd: root, encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('staging.enc.env');
  expect(result.stderr + result.stdout).not.toContain('private-fixture-value');
});

test('clean staged content reaches affected typechecks and propagates their failure', () => {
  const root = fixture();
  writeFileSync(join(root, 'scripts/src/file with spaces.ts'), 'export const value = 2;\n');
  git(root, ['add', 'scripts/src/file with spaces.ts']);
  const bin = join(root, 'node_modules/.bin');
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nprintf "%s\\n" "$@" > guard-args.txt\nexit 0\n');
  chmodSync(join(bin, 'bun'), 0o755);
  writeFileSync(join(bin, 'moon'), '#!/bin/sh\nprintf "%s\\n" "$@" > moon-args.txt\nexit 27\n');
  chmodSync(join(bin, 'moon'), 0o755);
  const result = spawnSync(process.execPath, [source], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  expect(result.status).toBe(27);
  expect(readFileSync(join(root, 'guard-args.txt'), 'utf8')).toBe(
    'run\nscripts/src/cli.ts\nguard\n',
  );
  const args = readFileSync(join(root, 'moon-args.txt'), 'utf8');
  expect(args).toContain('--affected\n--status=staged\n');
  expect(args).toContain('--cache\noff\n');
  expect(args).toContain('--downstream\ndeep\n');
});

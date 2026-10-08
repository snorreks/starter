import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapWorktree } from '../src/commands/worktree.ts';

const dirs: string[] = [];
const envKeys = [
  'PATH',
  'OPENROUTER_API_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'IN_NIX_SHELL',
] as const;
const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
afterEach(() => {
  for (const key of envKeys) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fresh worktree bootstrap uses pinned Nix setup and strips review/admin credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'starter-bootstrap-'));
  dirs.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const argsFile = join(root, 'args.txt');
  const nix = join(bin, 'nix');
  writeFileSync(
    nix,
    `#!/bin/sh\nif [ -n "\${OPENROUTER_API_KEY:-}" ] || [ -n "\${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then exit 91; fi\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 0\n`,
  );
  chmodSync(nix, 0o755);
  process.env.PATH = `${bin}:${saved.PATH ?? ''}`;
  process.env.OPENROUTER_API_KEY = 'review-secret-fixture';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'admin-secret-fixture';
  delete process.env.IN_NIX_SHELL;

  expect(await bootstrapWorktree(root)).toBe(0);
  expect(readFileSync(argsFile, 'utf8')).toBe('develop\n--command\nbun\nrun\nsetup\n');
});

test('an explicit review source reaches bootstrap by path while values stay out of argv', async () => {
  const root = mkdtempSync(join(tmpdir(), 'starter-bootstrap-source-'));
  dirs.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const argsFile = join(root, 'args.txt');
  const nix = join(bin, 'nix');
  writeFileSync(nix, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\nexit 0\n`);
  chmodSync(nix, 0o755);
  const source = join(root, 'trusted.env');
  writeFileSync(
    source,
    'E2E_VISION_MODEL=vendor/model\nOPENROUTER_API_KEY=review-secret-fixture\n',
  );
  process.env.PATH = `${bin}:${saved.PATH ?? ''}`;
  delete process.env.IN_NIX_SHELL;

  expect(await bootstrapWorktree(root, source)).toBe(0);
  const args = readFileSync(argsFile, 'utf8');
  expect(readFileSync(join(root, '.env.e2e'), 'utf8')).toContain('E2E_VISION_MODEL="vendor/model"');
  expect(args).not.toContain('review-secret-fixture');
});

test('the public bootstrap entrypoint installs before importing workspace tooling', () => {
  const root = mkdtempSync(join(tmpdir(), 'starter-bootstrap-cold-'));
  dirs.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const calls = join(root, 'calls.txt');
  const bun = join(bin, 'bun');
  writeFileSync(
    bun,
    `#!/bin/sh\nif [ -n "\${OPENROUTER_API_KEY:-}" ] || [ -n "\${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then exit 91; fi\nprintf '%s\\n' "$*" >> "${calls}"\nexit 0\n`,
  );
  chmodSync(bun, 0o755);

  const script = fileURLToPath(new URL('../bootstrap-worktree.ts', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--from', '/trusted/review.env'], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      OPENROUTER_API_KEY: 'review-secret-fixture',
      SUPABASE_SERVICE_ROLE_KEY: 'admin-secret-fixture',
    },
    encoding: 'utf8',
  });

  expect(result.status).toBe(0);
  expect(readFileSync(calls, 'utf8')).toBe(
    'install --frozen-lockfile\nrun scripts/src/cli.ts worktree bootstrap --from /trusted/review.env\n',
  );
  expect(result.stdout + result.stderr).not.toContain('review-secret-fixture');
});

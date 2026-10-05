import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  needsDeploymentCredential,
  withDeploymentCredential,
} from '../src/deploy/local_credential.ts';

const roots: string[] = [];
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'deploy-credential-'));
  roots.push(root);
  expect(spawnSync('git', ['init', '--quiet'], { cwd: root }).status).toBe(0);
  writeFileSync(join(root, '.gitignore'), '.env.deploy\n');
  writeFileSync(join(root, '.env.deploy'), 'CLOUDFLARE_API_TOKEN="fixture-only-token"\n', {
    mode: 0o600,
  });
  return root;
};

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a local deploy token exists only during its command, including failure', async () => {
  const env: NodeJS.ProcessEnv = {};
  const root = fixture();
  await expect(
    withDeploymentCredential({
      root,
      env,
      run: () => {
        expect(env.CLOUDFLARE_API_TOKEN).toBe('fixture-only-token');
        throw new Error('command failed');
      },
    }),
  ).rejects.toThrow('command failed');
  expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
});

test('CI injection wins over even an invalid local credential file', async () => {
  const root = fixture();
  writeFileSync(join(root, '.env.deploy'), 'UNKNOWN=must-not-load\n');
  const env = { CLOUDFLARE_API_TOKEN: 'injected-token' };
  expect(
    await withDeploymentCredential({
      root,
      env,
      run: () => {
        expect(env.CLOUDFLARE_API_TOKEN).toBe('injected-token');
        return 0;
      },
    }),
  ).toBe(0);
});

test('an absent file leaves the credential prerequisite to the command', async () => {
  const root = fixture();
  rmSync(join(root, '.env.deploy'));
  expect(await withDeploymentCredential({ root, env: {}, run: () => 3 })).toBe(3);
});

test('a forced-tracked credential is refused even when gitignore matches it', async () => {
  const root = fixture();
  expect(spawnSync('git', ['add', '--force', '.env.deploy'], { cwd: root }).status).toBe(0);
  await expect(withDeploymentCredential({ root, env: {}, run: () => 0 })).rejects.toThrow(
    'untracked',
  );
});

test('a local token must be ignored, not just untracked', async () => {
  const root = fixture();
  writeFileSync(join(root, '.gitignore'), '');
  await expect(withDeploymentCredential({ root, env: {}, run: () => 0 })).rejects.toThrow(
    'gitignored',
  );
});

test('unknown variable contents never reach the error message or environment', async () => {
  const root = fixture();
  writeFileSync(
    join(root, '.env.deploy'),
    'CLOUDFLARE_API_TOKEN=private-fixture\nVITE_TOKEN=leak-fixture\n',
  );
  const env: NodeJS.ProcessEnv = {};
  await expect(withDeploymentCredential({ root, env, run: () => 0 })).rejects.toThrow(
    'only a nonempty CLOUDFLARE_API_TOKEN',
  );
  expect(env).toEqual({});
});

test.skipIf(process.platform === 'win32')('a broadly readable credential is refused', async () => {
  const root = fixture();
  chmodSync(join(root, '.env.deploy'), 0o644);
  await expect(withDeploymentCredential({ root, env: {}, run: () => 0 })).rejects.toThrow(
    'chmod 600',
  );
});

test.skipIf(process.platform === 'win32')('a credential symlink is refused', async () => {
  const root = fixture();
  const path = join(root, '.env.deploy');
  rmSync(path);
  writeFileSync(join(root, 'other'), 'CLOUDFLARE_API_TOKEN=fixture', { mode: 0o600 });
  symlinkSync(join(root, 'other'), path);
  await expect(withDeploymentCredential({ root, env: {}, run: () => 0 })).rejects.toThrow(
    'not a symlink',
  );
});

test('offline plans, dev, builds, help, and local logs never load the token', () => {
  for (const command of ['dev', 'setup', 'update', 'cached']) {
    expect(needsDeploymentCredential({ command, args: [] })).toBe(false);
  }
  for (const args of [['plan'], ['status'], ['apply', '--dry-run'], ['--help']]) {
    expect(needsDeploymentCredential({ command: 'deploy', args })).toBe(false);
  }
  expect(needsDeploymentCredential({ command: 'deploy', args: ['apply', '--yes'] })).toBe(true);
  expect(needsDeploymentCredential({ command: 'logs', args: ['web', '--mode', 'local'] })).toBe(
    false,
  );
  expect(needsDeploymentCredential({ command: 'configure', args: ['--provision'] })).toBe(true);
  expect(needsDeploymentCredential({ command: 'db', args: ['migrate', '--remote'] })).toBe(true);
  // `db migrate --remote staging --dry-run` prints the command it would run and
  // stops: it reaches no remote, so loading the deploy credential for it would
  // refuse a plan with a missing `.env.deploy` and read a secret it never uses.
  expect(
    needsDeploymentCredential({
      command: 'db',
      args: ['migrate', '--remote', 'staging', '--dry-run'],
    }),
  ).toBe(false);
  // The flag order is the operator's, not the parser's.
  expect(
    needsDeploymentCredential({
      command: 'db',
      args: ['migrate', '--dry-run', '--remote'],
    }),
  ).toBe(false);
});

import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROFILES, profileCheckNames } from '../src/setup/profiles.ts';

const roots: string[] = [];
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-doctor-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setup profiles do not require Proto for Moon tasks', () => {
  for (const profile of PROFILES) {
    expect(profileCheckNames(profile)).not.toContain('proto');
  }
});

if (process.platform !== 'win32') {
  test('listing profile names never launches host tools, while doctor still probes them', () => {
    const root = fixture();
    const marker = join(root, 'probed');
    const binary = join(root, 'rustc');
    writeFileSync(binary, `#!/bin/sh\n: > "${marker}"\nexit 1\n`);
    chmodSync(binary, 0o755);
    const profilesModule = new URL('../src/setup/profiles.ts', import.meta.url).href;
    const run = (expression: string) =>
      spawnSync(
        process.execPath,
        [
          '-e',
          `import { PROFILES, profileCheckNames, profileChecks } from ${JSON.stringify(profilesModule)}; ${expression}`,
        ],
        { env: { ...process.env, PATH: root }, encoding: 'utf8', timeout: 2000 },
      );
    const names = run('for (const profile of PROFILES) profileCheckNames(profile);');
    expect(names.status).toBe(0);
    expect(existsSync(marker)).toBe(false);
    const checks = run('profileChecks("native");');
    expect(checks.status).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });
}

test('the database profile requires Docker without depending on the media crate', () => {
  const checks = profileCheckNames('database');
  expect(checks).toContain('docker');
  expect(checks).toContain('docker-engine');
  expect(checks).not.toContain('cargo-media');
  expect(profileCheckNames('compute')).toContain('cargo-media');
});

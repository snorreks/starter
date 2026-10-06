import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { protoCheck } from '../src/setup/doctor.ts';
import { PROFILES, profileCheckNames } from '../src/setup/profiles.ts';

const roots: string[] = [];
const fixture = (minimum: unknown = '0.60.0-alpha.0'): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-doctor-'));
  roots.push(root);
  mkdirSync(join(root, 'config'));
  writeFileSync(
    join(root, 'config/toolchain.json'),
    JSON.stringify({ proto: { minimum, verified: '0.62.3' } }),
  );
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [version, ok] of [
  ['0.56.4', false],
  ['0.60.0-alpha.0', true],
  ['0.60.0-alpha.1', true],
  ['0.60.0', true],
  ['0.62.3', true],
  ['0.63.0-alpha.0', true],
  ['1.0.0', true],
  ['unknown', false],
] as const) {
  test(`proto ${version} ${ok ? 'meets' : 'fails'} the configured floor`, () => {
    const check = protoCheck({ root: fixture(), probe: () => `proto ${version}` });
    expect(check.ok).toBe(ok);
    expect(check.severity).toBe('required');
    expect(check.detail).toContain('0.60.0-alpha.0');
  });
}

test('raising the configured proto floor rejects a previously accepted host', () => {
  expect(protoCheck({ root: fixture('0.64.0'), probe: () => 'proto 0.63.0' }).ok).toBe(false);
});

test('doctor finds proto in its home even when it is absent from PATH', () => {
  const root = fixture();
  const binary = join(root, 'bin', process.platform === 'win32' ? 'proto.exe' : 'proto');
  const calls: string[] = [];
  const check = protoCheck({
    root,
    protoHome: root,
    probe: (command) => {
      calls.push(command);
      return command === binary ? 'proto 0.62.4' : null;
    },
  });
  expect(check.ok).toBe(true);
  expect(calls).toEqual([binary]);
});

test('doctor falls back to proto on PATH and fails if neither binary runs', () => {
  const root = fixture();
  expect(
    protoCheck({ root, probe: (command) => (command === 'proto' ? 'proto 0.62.4' : null) }).ok,
  ).toBe(true);
  const absent = protoCheck({ root, probe: () => null });
  expect(absent.ok).toBe(false);
  expect(absent.remedy).toContain('0.60.0-alpha.0');
});

for (const minimum of [undefined, 'not-a-version']) {
  test(`a ${minimum === undefined ? 'missing' : 'malformed'} proto floor fails closed`, () => {
    const root = fixture();
    writeFileSync(join(root, 'config/toolchain.json'), JSON.stringify({ proto: { minimum } }));
    const check = protoCheck({ root, probe: () => 'proto 0.62.3' });
    expect(check.ok).toBe(false);
    expect(check.detail).toContain('proto.minimum');
  });
}

test('every setup profile names the required proto check', () => {
  for (const profile of PROFILES) {
    expect(profileCheckNames(profile)).toContain('proto');
  }
});

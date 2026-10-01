import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptFile, EXIT, updateRecipients } from '../src/secrets/sops.ts';

const roots: string[] = [];
const makeRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-secret-refusals-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', root]);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['.', '..private.env'])('refuses in-repository plaintext output %s', (out) => {
  const root = makeRepo();
  writeFileSync(join(root, 'input.enc.env'), 'fixture');
  const result = decryptFile('input.enc.env', out, root);
  expect(result.code).toBe(EXIT.refused);
  expect(result.stderr).toContain('Refusing to write decrypted output');
});

test('recipient updates refuse a config with no extendable age list', () => {
  const root = makeRepo();
  const text = 'creation_rules: []\n';
  writeFileSync(join(root, '.sops.yaml'), text);
  expect(updateRecipients([`age1${'a'.repeat(58)}`], root)).toBe(EXIT.failed);
  expect(readFileSync(join(root, '.sops.yaml'), 'utf8')).toBe(text);
});

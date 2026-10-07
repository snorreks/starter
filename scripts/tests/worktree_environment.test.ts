import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTrustedReviewSettings } from '../src/setup/worktree_environment.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});
const tree = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-worktree-env-'));
  roots.push(root);
  return root;
};

test('trusted import copies only optional review settings and creates a private file', () => {
  const root = tree();
  const source = join(root, 'trusted.env');
  writeFileSync(
    source,
    'E2E_VISION_MODEL=vendor/model\nOPENROUTER_API_KEY=local-key\nCLOUDFLARE_API_TOKEN=deploy-token\n',
  );
  expect(() => importTrustedReviewSettings(root, source)).toThrow(
    'unsupported names: CLOUDFLARE_API_TOKEN',
  );
  expect(existsSync(join(root, '.env.e2e'))).toBe(false);
  writeFileSync(source, 'E2E_VISION_MODEL=vendor/model\nOPENROUTER_API_KEY=local-key\n');
  expect(importTrustedReviewSettings(root, source)).toEqual([
    'E2E_VISION_MODEL',
    'OPENROUTER_API_KEY',
  ]);
  const destination = join(root, '.env.e2e');
  expect(statSync(destination).mode & 0o777).toBe(0o600);
  expect(readFileSync(destination, 'utf8')).toContain('E2E_VISION_MODEL="vendor/model"');
  expect(readFileSync(destination, 'utf8')).not.toContain('CLOUDFLARE');
});

test('an existing worktree review file is left byte-for-byte intact', () => {
  const root = tree();
  const source = join(root, 'trusted.env');
  const target = join(root, '.env.e2e');
  writeFileSync(source, 'E2E_VISION_MODEL=vendor/model\n');
  writeFileSync(target, 'E2E_VISION_MODEL=kept/model\n');
  expect(() => importTrustedReviewSettings(root, source)).toThrow('refusing to replace');
  expect(readFileSync(target, 'utf8')).toBe('E2E_VISION_MODEL=kept/model\n');
});

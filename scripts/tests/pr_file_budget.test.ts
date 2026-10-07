import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPrFileBudget } from '../src/ci/pr_file_budget.ts';

const roots: string[] = [];
const repo = (): { root: string; base: string } => {
  const root = mkdtempSync(join(tmpdir(), 'starter-pr-budget-'));
  roots.push(root);
  const run = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: root });
  expect(run(['init', '-q']).exitCode).toBe(0);
  expect(run(['config', 'user.email', 'budget@example.test']).exitCode).toBe(0);
  expect(run(['config', 'user.name', 'Budget Test']).exitCode).toBe(0);
  writeFileSync(join(root, '.gitignore'), 'generated/\n');
  writeFileSync(join(root, 'base.txt'), 'base');
  expect(run(['add', '.']).exitCode).toBe(0);
  expect(run(['commit', '-qm', 'base']).exitCode).toBe(0);
  return {
    root,
    base: Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: root }).stdout.toString().trim(),
  };
};
const git = (root: string, ...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: root });

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('PR changed path budget', () => {
  test('accepts exactly 99 and rejects 100 changed paths', () => {
    const { root, base } = repo();
    for (let i = 0; i < 100; i++) {
      writeFileSync(join(root, `file-${i}.txt`), 'x');
    }
    expect(checkPrFileBudget({ cwd: root, base, maxFiles: 99 })).toMatchObject({
      ok: false,
      count: 100,
    });
    expect(checkPrFileBudget({ cwd: root, base, maxFiles: 100 })).toMatchObject({
      ok: true,
      count: 100,
    });
    rmSync(join(root, 'file-99.txt'));
    expect(checkPrFileBudget({ cwd: root, base, maxFiles: 99 })).toMatchObject({
      ok: true,
      count: 99,
    });
  });
  test('conservatively counts a rename as a deletion and an addition', () => {
    const { root, base } = repo();
    writeFileSync(join(root, 'renamed.txt'), 'base');
    git(root, 'rm', 'base.txt');
    git(root, 'add', 'renamed.txt');
    expect(checkPrFileBudget({ cwd: root, base, maxFiles: 1 }).count).toBe(2);
  });
  test('counts changed and deleted tracked paths but ignores ignored generated output', () => {
    const { root, base } = repo();
    mkdirSync(join(root, 'generated'));
    writeFileSync(join(root, 'generated', 'output.js'), 'ignored');
    writeFileSync(join(root, 'tracked-generated.ts'), 'generated');
    git(root, 'add', 'tracked-generated.ts');
    git(root, 'commit', '-qm', 'generated source');
    writeFileSync(join(root, 'tracked-generated.ts'), 'changed');
    expect(checkPrFileBudget({ cwd: root, base, maxFiles: 2 }).count).toBe(1);
    expect(git(root, 'rm', 'base.txt').exitCode).toBe(0);
    expect(checkPrFileBudget({ cwd: root, base, maxFiles: 2 }).count).toBe(2);
  });
  test('includes staged, unstaged, and checkout-owned untracked paths', () => {
    const { root, base } = repo();
    writeFileSync(join(root, 'staged.ts'), 'x');
    git(root, 'add', 'staged.ts');
    writeFileSync(join(root, 'base.txt'), 'unstaged change');
    writeFileSync(join(root, 'untracked.ts'), 'x');
    expect(checkPrFileBudget({ cwd: root, base, maxFiles: 3 }).count).toBe(3);
  });
  test('excludes upstream-only changes after the branches diverge', () => {
    const { root, base } = repo();
    writeFileSync(join(root, 'upstream.txt'), 'upstream');
    expect(git(root, 'add', '.').exitCode).toBe(0);
    expect(git(root, 'commit', '-qm', 'upstream change').exitCode).toBe(0);
    const upstream = git(root, 'rev-parse', 'HEAD').stdout.toString().trim();
    expect(git(root, 'checkout', '--detach', base).exitCode).toBe(0);
    writeFileSync(join(root, 'feature.txt'), 'feature');
    expect(git(root, 'add', '.').exitCode).toBe(0);
    expect(git(root, 'commit', '-qm', 'feature change').exitCode).toBe(0);
    expect(checkPrFileBudget({ cwd: root, base: upstream, maxFiles: 1 })).toMatchObject({
      ok: true,
      count: 1,
      paths: ['feature.txt'],
    });
  });
  test('counts a staged path once when its working tree content is reverted to HEAD', () => {
    const { root, base } = repo();
    writeFileSync(join(root, 'base.txt'), 'staged change');
    expect(git(root, 'add', 'base.txt').exitCode).toBe(0);
    writeFileSync(join(root, 'base.txt'), 'base');
    expect(checkPrFileBudget({ cwd: root, base, maxFiles: 1 })).toMatchObject({
      ok: true,
      count: 1,
      paths: ['base.txt'],
    });
  });
  test('rejects missing and invalid bases instead of choosing one', () => {
    const { root } = repo();
    expect(() => checkPrFileBudget({ cwd: root, base: '', maxFiles: 99 })).toThrow(/base/i);
    expect(() => checkPrFileBudget({ cwd: root, base: 'no-such-ref', maxFiles: 99 })).toThrow(
      /base/i,
    );
  });
});

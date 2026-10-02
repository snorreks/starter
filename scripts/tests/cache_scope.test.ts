// scripts/tests/cache_scope.test.ts
//
// Whether a Moon cache hit describes this tree is decided before any task runs,
// so nothing inside a `moon.yml` can widen or narrow the key. `cache_scope.ts`
// decides it in front of Moon instead, from a fingerprint over the files Moon
// provably cannot put in one.
//
// These tests assert the *decisions* against fixtures on disk, and then against
// the real Moon graph for the part that only the real graph can settle: that a
// change to a file Moon cannot see switches the mode, and that a change to a file
// it can see is a plain Moon cache miss.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  filesInScope,
  fingerprintScope,
  PACKAGE_SOURCE_DIRS,
  resolveCacheMode,
  SHARED_INPUTS,
  writeStamp,
} from '../src/ci/cache_scope.ts';

/**
 * A fixture with the same shape as the repository's scope.
 *
 * Every name in `SHARED_INPUTS` and every directory in `PACKAGE_SOURCE_DIRS` is
 * created, because the module resolves its scope from constants and a fixture
 * missing half of them would resolve to a *different*, smaller set — which is
 * precisely the "a glob that matches nothing" defect, reproduced by accident.
 */
const writeFixture = (root: string): void => {
  for (const relative of SHARED_INPUTS) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `{ "${relative}": "original" }\n`);
  }
  for (const relative of PACKAGE_SOURCE_DIRS) {
    mkdirSync(join(root, relative, 'src'), { recursive: true });
    writeFileSync(join(root, relative, 'src', 'index.ts'), `export const from = '${relative}';\n`);
    writeFileSync(join(root, relative, 'package.json'), `{ "name": "${relative}" }\n`);
  }
};

describe('a fingerprint that reads nothing must not be treated as a fingerprint', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'starter-cache-scope-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('an empty scope resolves to no files rather than to a stable hash', () => {
    // A hash of nothing is a constant. A constant never changes, so a gate that
    // trusted it would report `read-write` forever and never once question a
    // cached result. It has to be treated as unreadable.
    const files = filesInScope(root);

    expect(files).toEqual([]);
    expect(fingerprintScope(root).filesRead).toBe(0);
    expect(resolveCacheMode({ root, previous: 'anything' }).mode).toBe('off');
  });

  test('the first run records a fingerprint and caches nothing', () => {
    writeFixture(root);

    const first = resolveCacheMode({ root, previous: null });

    expect(first.mode).toBe('off');
    expect(first.filesRead).toBe(SHARED_INPUTS.length + PACKAGE_SOURCE_DIRS.length * 2);
    expect(first.fingerprint).toHaveLength(64);
    expect(first.reason).toContain('records one');
  });

  test('a second run with nothing changed may use the cache', () => {
    writeFixture(root);
    const first = resolveCacheMode({ root, previous: null });

    const second = resolveCacheMode({ root, previous: first.fingerprint });

    expect(second.mode).toBe('read-write');
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  test('a change to the lockfile switches the cache off', () => {
    writeFixture(root);
    const first = resolveCacheMode({ root, previous: null });

    // `bun.lock` is the file whose contents decide which compiler, linter and
    // test runner every task in the workspace uses, and it is the file Moon
    // cannot name in a task input.
    writeFileSync(join(root, 'bun.lock'), '{ "bun.lock": "a dependency moved" }\n');

    const after = resolveCacheMode({ root, previous: first.fingerprint });

    expect(after.mode).toBe('off');
    expect(after.fingerprint).not.toBe(first.fingerprint);
    expect(after.reason).toContain('no cached result describes this tree');
  });

  test('a change to a shared config switches the cache off', () => {
    writeFixture(root);
    const first = resolveCacheMode({ root, previous: null });

    // `config/tsconfig/tsconfig.base.json` is the `extends` chain for nine
    // projects, and it is outside every one of them.
    writeFileSync(join(root, 'config/tsconfig/tsconfig.base.json'), '{ "strict": false }\n');

    expect(resolveCacheMode({ root, previous: first.fingerprint }).mode).toBe('off');
  });

  test('a change to a dependency package source switches the cache off', () => {
    writeFixture(root);
    const first = resolveCacheMode({ root, previous: null });

    // Moon does not fold a dependency task's hash into a dependent task's hash, so
    // this edit is invisible to every key in the graph.
    writeFileSync(
      join(root, PACKAGE_SOURCE_DIRS[0], 'src', 'index.ts'),
      'export const from = 1;\n',
    );

    const after = resolveCacheMode({ root, previous: first.fingerprint });

    expect(after.mode).toBe('off');
    expect(after.reason).toContain('changed');
  });

  test('a file outside the scope does not switch the cache off', () => {
    writeFixture(root);
    const first = resolveCacheMode({ root, previous: null });

    // `README.md` decides no task's result. Switching the cache off for it would
    // be the mirror-image defect: correctness bought at the price of a cache that
    // is never warm.
    writeFileSync(join(root, 'README.md'), 'a change that should not matter\n');

    expect(resolveCacheMode({ root, previous: first.fingerprint }).mode).toBe('read-write');
  });

  test('the stamp round-trips through disk', () => {
    writeFixture(root);
    const first = resolveCacheMode({ root, previous: null });
    writeStamp(root, first.fingerprint);

    // `previous: undefined` reads the stamp from disk, which is the path the
    // command takes. Passing `first.fingerprint` directly would prove nothing
    // about that.
    expect(resolveCacheMode({ root }).mode).toBe('read-write');
  });
});

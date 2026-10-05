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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  filesInScope,
  fingerprintScope,
  PACKAGE_SOURCE_DIRS,
  purgeMoonCache,
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

/** A fake Moon cache entry, named the way Moon names one. */
const seedMoonEntry = (root: string, hash: string): void => {
  mkdirSync(join(root, '.moon', 'cache', 'hashes'), { recursive: true });
  mkdirSync(join(root, '.moon', 'cache', 'outputs'), { recursive: true });
  mkdirSync(join(root, '.moon', 'cache', 'states'), { recursive: true });
  writeFileSync(join(root, '.moon', 'cache', 'hashes', `${hash}.json`), '{"command":"bun"}\n');
  writeFileSync(join(root, '.moon', 'cache', 'outputs', `${hash}.tar.gz`), 'artifact\n');
  writeFileSync(join(root, '.moon', 'cache', 'states', 'workspaceGraph.json'), '{}\n');
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

  test('a change to the shared browser resolver switches the cache off', () => {
    writeFixture(root);
    const first = resolveCacheMode({ root, previous: null });

    // `browser_path.ts` decides which Chromium both browser lanes launch, and it
    // lives in `scripts/`, so Moon cannot name it in `client`'s or `e2e`'s inputs —
    // and `scripts/moon.yml` cannot reference it either, for the same `..` reason.
    // Without it in scope, editing it left both lanes' cached results eligible.
    writeFileSync(
      join(root, 'scripts/src/shared/browser_path.ts'),
      'export const which = "a different browser";\n',
    );

    expect(resolveCacheMode({ root, previous: first.fingerprint }).mode).toBe('off');
  });

  test('a change to the Worker bundler switches the cache off', () => {
    writeFixture(root);
    const first = resolveCacheMode({ root, previous: null });

    // `client:build` is `vite build && bundle_worker.ts`. The bundler decides
    // whether the artifact is a closed standalone Worker or the adapter's own
    // unbundled entry, and Moon cannot see it from the client's task — so a
    // change to it would have restored a Worker built by the previous bundler.
    writeFileSync(
      join(root, 'scripts/src/artifacts/bundle_worker.ts'),
      'export const bundled = false;\n',
    );

    expect(resolveCacheMode({ root, previous: first.fingerprint }).mode).toBe('off');
  });
});

describe('a changed fingerprint must leave no cache entry eligible to be restored', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'starter-cache-stale-'));
    writeFixture(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('the entries Moon would match are discarded, not merely unread this run', () => {
    // This is the whole defect. `--cache off` disables the cache for one run; it
    // deletes nothing. Measured on the real graph before the purge existed:
    //
    //   1. warm under fingerprint F1   -> `read-write`, stores key H
    //   2. run again                   -> `cached, 0a00b1e9`
    //   3. edit bun.lock               -> fingerprint F2, Moon's own key unchanged
    //   4. run                         -> gate `off`, re-runs
    //   5. run again                   -> gate `read-write`, and Moon RESTORES H,
    //                                     which was computed under F1
    //
    // Step 5 is the gate agreeing with itself while certifying a result from a tree
    // it had already disowned. `hashes/` holds the key Moon matches, `outputs/` the
    // artifact it restores — including `client:build`'s `.svelte-kit/cloudflare`,
    // the only restorable output in this workspace.
    const H = 'a'.repeat(64);
    seedMoonEntry(root, H);
    writeStamp(root, 'a'.repeat(64));

    const changed = resolveCacheMode({ root });
    expect(changed.mode).toBe('off');
    expect(changed.reason).toContain('changed');

    const { purged } = purgeMoonCache(root);

    expect(purged).toContain('hashes');
    expect(purged).toContain('outputs');
    expect(existsSync(join(root, '.moon', 'cache', 'hashes', `${H}.json`))).toBe(false);
    expect(existsSync(join(root, '.moon', 'cache', 'outputs', `${H}.tar.gz`))).toBe(false);
  });

  test('states survive: they describe the tool, not the tree', () => {
    // `states/` holds Moon's version check and resolved workspace graph. Rebuilding
    // it costs seconds on every run and it describes Moon rather than this checkout,
    // so discarding it alongside the tree data buys nothing.
    const H = 'b'.repeat(64);
    seedMoonEntry(root, H);
    writeStamp(root, 'b'.repeat(64));

    purgeMoonCache(root);

    expect(existsSync(join(root, '.moon', 'cache', 'states', 'workspaceGraph.json'))).toBe(true);
  });

  test('the stamp advancing is what would restore an older result, so purge comes first', () => {
    // The sequence asserted rather than narrated. Once the new stamp exists the next
    // run says `read-write`, and the only thing between it and the old result is
    // that the entry is gone.
    const H = 'c'.repeat(64);
    seedMoonEntry(root, H);
    writeStamp(root, 'c'.repeat(64));

    const changed = resolveCacheMode({ root });
    expect(changed.mode).toBe('off');

    // A run that recorded the new fingerprint without purging.
    writeStamp(root, changed.fingerprint);
    expect(existsSync(join(root, '.moon', 'cache', 'hashes', `${H}.json`))).toBe(true);

    // With the purge, in the order the command performs them.
    purgeMoonCache(root);
    writeStamp(root, changed.fingerprint);
    expect(existsSync(join(root, '.moon', 'cache', 'hashes', `${H}.json`))).toBe(false);
    expect(resolveCacheMode({ root }).mode).toBe('read-write');
  });

  test('a warm run purges nothing', () => {
    // Keyed on a *change*, so an ordinary run pays nothing. A cache lost on every
    // invocation would be worse than no cache.
    writeFixture(root);
    const first = resolveCacheMode({ root, previous: null });
    writeStamp(root, first.fingerprint);
    seedMoonEntry(root, 'd'.repeat(64));

    expect(resolveCacheMode({ root }).mode).toBe('read-write');
    // The gate's own signal for "nothing changed", rather than a substring search:
    // `reason` says "unchanged" on the warm path and "changed" on the cold one, and
    // the first contains the second as a substring.
    expect(resolveCacheMode({ root }).reason).toContain('are unchanged');
  });
});

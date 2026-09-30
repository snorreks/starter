// scripts/src/lib/paths.test.ts
//
// The resolved repository paths must actually exist.
//
// This is a five-line test guarding a bug that has now happened twice in this
// session and that produces misleading failures every time. `REPO_ROOT` resolved to
// the *parent* of the repository, and the symptom was:
//
//   ENOENT: no such file or directory,
//   open '/home/sonny/.../passion/apps/backend/api/wrangler.jsonc'
//
// — one directory above the checkout, phrased as a missing file. `planMigrate` then
// reported "No migrations found", and the deploy plan could not name its config.
//
// Getting the `../` depth wrong is silent: nothing throws, every path is
// constructed successfully, and the result is simply wrong. Asserting that the
// resolved directories exist turns that class of error into a failing test at the
// point of introduction.

import { describe, expect, test } from 'bun:test';
import { existsSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { API_DIR, CLIENT_DIR, DATABASE_DIR, E2E_DIR, PI_DIR, REPO_ROOT } from '../src/shared/paths.ts';

describe('repository paths', () => {
  test('REPO_ROOT is a directory named after the repository', () => {
    // Not "ends with starter" — any correct checkout has a non-empty basename.
    expect(statSync(REPO_ROOT).isDirectory()).toBe(true);
    expect(basename(REPO_ROOT).length).toBeGreaterThan(0);
  });

  test('REPO_ROOT is not the parent of the repository', () => {
    // The specific regression: one `../` too many, so `REPO_ROOT` was
    // `/home/…/passion` rather than `/home/…/passion/starter`.
    expect(dirname(REPO_ROOT)).not.toBe(REPO_ROOT);
    expect(existsSync(`${REPO_ROOT}/apps/backend/api/wrangler.jsonc`)).toBe(true);
    expect(existsSync(`${REPO_ROOT}/package.json`)).toBe(true);
    expect(existsSync(`${REPO_ROOT}/.moon/workspace.yml`)).toBe(true);
  });

  test.each([
    ['API_DIR', API_DIR, 'apps/backend/api'],
    ['CLIENT_DIR', CLIENT_DIR, 'apps/frontend/client'],
    ['E2E_DIR', E2E_DIR, 'apps/e2e'],
    ['DATABASE_DIR', DATABASE_DIR, 'packages/backend/database'],
    ['PI_DIR', PI_DIR, '.pi'],
  ])('%s resolves inside the repository', (_name, dir, suffix) => {
    expect(existsSync(dir)).toBe(true);
    expect(dir.startsWith(REPO_ROOT)).toBe(true);
    expect(dir.endsWith(suffix)).toBe(true);
  });

  test('paths are not percent-encoded', () => {
    // `new URL(...).pathname` percent-encodes; a checkout under a directory with a
    // space would resolve to a path that does not exist.
    expect(REPO_ROOT).not.toMatch(/%[0-9A-Fa-f]{2}/);
    for (const dir of [API_DIR, CLIENT_DIR, E2E_DIR, DATABASE_DIR, PI_DIR]) {
      expect(dir).not.toMatch(/%[0-9A-Fa-f]{2}/);
    }
  });

  test('paths have no trailing separator', () => {
    // A trailing slash makes `path.startsWith()` comparisons and string equality
    // behave differently for the same directory.
    for (const dir of [REPO_ROOT, API_DIR, CLIENT_DIR, E2E_DIR, DATABASE_DIR, PI_DIR]) {
      expect(dir.endsWith('/')).toBe(false);
    }
  });
});

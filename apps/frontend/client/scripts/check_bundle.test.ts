// apps/frontend/client/scripts/check_bundle.test.ts
//
// The bundle check, against fixture bundles.
//
// Every fixture here is written to a temporary directory, so these tests need no
// build and cannot pass by accident on whatever happens to be in `build/`.
//
// The mode check is the one that earns the file. A browser bundle that imports
// `@tauri-apps/*` ships native calls that throw; a native bundle built with the
// stub in place ships an app with no native layer. Both compile. Both look fine.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BuildMode, checkBundle, stubMarkerIntact } from './check_bundle.ts';

const STUB_MARKER = 'is a Tauri API and is not available in a browser build';

const fixture = (
  scripts: Record<string, string>,
  index = '<script>import("/_app/immutable/entry/start.abc123.js")</script>',
): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
  mkdirSync(join(dir, '_app/immutable/entry'), { recursive: true });
  mkdirSync(join(dir, '_app/immutable/chunks'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), `<html><body>${index}</body></html>`);
  writeFileSync(join(dir, '_app/immutable/entry/start.abc123.js'), '// entry\n');
  for (const [name, source] of Object.entries(scripts)) {
    writeFileSync(join(dir, `_app/immutable/chunks/${name}`), source);
  }
  return dir;
};

const withDir = (dir: string, body: () => void): void => {
  try {
    body();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const codes = (mode: BuildMode, dir: string): string[] =>
  checkBundle(mode, dir).map((problem) => problem.code);

describe('checkBundle', () => {
  test('the stub marker this check depends on still exists in the repository', () => {
    // If the stub's message changes, the mode check below would silently start
    // passing on a native bundle built with the stub in place.
    expect(stubMarkerIntact()).toBe(true);
  });

  test('an empty directory is reported, not passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    withDir(dir, () => {
      expect(codes('browser', dir)).toContain('no_output');
    });
  });

  test('a browser bundle carrying the stub passes', () => {
    const dir = fixture({ 'a.js': `throw new Error("${STUB_MARKER}");` });
    withDir(dir, () => {
      expect(checkBundle('browser', dir)).toEqual([]);
    });
  });

  test('a browser bundle WITHOUT the stub is reported', () => {
    // This is the case the original defect produced: a native-shaped bundle
    // checked (or shipped) as a browser bundle.
    const dir = fixture({ 'a.js': 'import { invoke } from "@tauri-apps/api/core";' });
    withDir(dir, () => {
      expect(codes('browser', dir)).toContain('mode_mismatch');
    });
  });

  test('a native build that still contains the stub is reported', () => {
    // And the mirror case: TAURI_NATIVE_BUILD unset on an Android or iOS build,
    // which shipped stubbed Tauri packages.
    const dir = fixture({ 'a.js': `throw new Error("${STUB_MARKER}");` });
    withDir(dir, () => {
      expect(codes('native', dir)).toContain('mode_mismatch');
    });
  });

  test('a native bundle with real Tauri code passes', () => {
    const dir = fixture({
      'a.js': 'import { invoke } from "@tauri-apps/api/core"; export { invoke };',
    });
    withDir(dir, () => {
      expect(checkBundle('native', dir)).toEqual([]);
    });
  });

  test('a missing index.html is reported', () => {
    const dir = fixture({ 'a.js': `throw new Error("${STUB_MARKER}");` });
    withDir(dir, () => {
      rmSync(join(dir, 'index.html'));
      expect(codes('browser', dir)).toContain('no_index');
    });
  });

  test('an index.html with no SvelteKit entry is reported', () => {
    const dir = fixture({ 'a.js': `throw new Error("${STUB_MARKER}");` }, '<html></html>');
    withDir(dir, () => {
      expect(codes('browser', dir)).toContain('no_entry_script');
    });
  });

  test('a shell with no assets is reported', () => {
    const dir = fixture({ 'a.js': `throw new Error("${STUB_MARKER}");` });
    withDir(dir, () => {
      rmSync(join(dir, '_app/immutable'), { recursive: true, force: true });
      const problems = codes('browser', dir);
      expect(problems).toContain('no_assets');
    });
  });

  test('a loopback URL in the bundle is not itself a failure', () => {
    // It is there on purpose, in a branch guarded by isTauri(): a Tauri webview
    // cannot use a relative /api URL. A static scan cannot tell a guarded
    // fallback from an unconditional destination, so asserting on it asserts
    // nothing — and this test exists so nobody "fixes" it by deleting the check.
    const dir = fixture({
      'a.js': `const t=isTauri()?\`http://127.0.0.1:\${p}\`:window.location.origin;throw new Error("${STUB_MARKER}");`,
    });
    withDir(dir, () => {
      expect(checkBundle('browser', dir)).toEqual([]);
    });
  });
});

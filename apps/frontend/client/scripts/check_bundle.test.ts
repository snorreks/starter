// apps/frontend/client/scripts/check_bundle.test.ts
//
// The bundle check, against fixture bundles.
//
// Every fixture here is written to a temporary directory, so these tests need no
// build and cannot pass by accident on whatever happens to be in `build/`.
//
// The native-import check is the one that earns the file. `@tauri-apps/*` calls
// into a shell that does not exist here, so it compiles, it bundles, and it
// throws when the screen that reaches it first runs. Only the assertion catches
// that, which is why it is here rather than left to a reviewer.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundle } from './check_bundle.ts';

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

const codes = (dir: string): string[] => checkBundle(dir).map((problem) => problem.code);

describe('checkBundle', () => {
  test('an empty directory is reported, not passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    withDir(dir, () => {
      expect(codes(dir)).toContain('no_output');
    });
  });

  test('a well-formed bundle passes', () => {
    const dir = fixture({ 'a.js': 'export const a = 1;\n' });
    withDir(dir, () => {
      expect(checkBundle(dir)).toEqual([]);
    });
  });

  test('a bundle that still imports a native shell is reported', () => {
    const dir = fixture({ 'a.js': 'import { invoke } from "@tauri-apps/api/core";' });
    withDir(dir, () => {
      expect(codes(dir)).toContain('native_import');
    });
  });

  test('the report names the file that carries the native import', () => {
    // Two chunks, only one of them native: a report that cannot say which one
    // leaves the reader searching the whole bundle for it.
    const dir = fixture({
      'clean.js': 'export const b = 2;\n',
      'dirty.js': 'import { invoke } from "@tauri-apps/api/core";\nexport { invoke };',
    });
    withDir(dir, () => {
      const native = checkBundle(dir).filter((problem) => problem.code === 'native_import');
      expect(native).toHaveLength(1);
      expect(native[0]?.message).toContain('dirty.js');
    });
  });

  test('a missing index.html is reported', () => {
    const dir = fixture({ 'a.js': 'export const a = 1;\n' });
    withDir(dir, () => {
      rmSync(join(dir, 'index.html'));
      expect(codes(dir)).toContain('no_index');
    });
  });

  test('an index.html with no SvelteKit entry is reported', () => {
    const dir = fixture({ 'a.js': 'export const a = 1;\n' }, '<html></html>');
    withDir(dir, () => {
      expect(codes(dir)).toContain('no_entry_script');
    });
  });

  test('a shell with no assets is reported', () => {
    const dir = fixture({ 'a.js': 'export const a = 1;\n' });
    withDir(dir, () => {
      rmSync(join(dir, '_app/immutable'), { recursive: true, force: true });
      expect(codes(dir)).toContain('no_assets');
    });
  });

  test('a loopback URL in the bundle is not itself a failure', () => {
    // It is there on purpose, in the branch that resolves the API base URL when
    // there is no browser origin to be relative to. A static scan cannot tell a
    // guarded fallback from an unconditional destination, so asserting on it
    // asserts nothing — and this test exists so nobody "fixes" it by deleting
    // the check.
    const dir = fixture({
      'a.js': 'const b=typeof window==="undefined"?`http://127.0.0.1:${p}`:window.location.origin;',
    });
    withDir(dir, () => {
      expect(checkBundle(dir)).toEqual([]);
    });
  });
});
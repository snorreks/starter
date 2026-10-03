// apps/frontend/native/scripts/check_bundle.test.ts
//
// The bundle control, exercised on fixtures rather than on a build.
//
// The failure mode this file exists to prevent is the one that makes a check
// worthless: a marker list that no longer matches anything, passing forever
// because the leak it was written for has been renamed. So every marker is
// planted in a temporary bundle and asserted to be caught, and a clean bundle is
// asserted to pass.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundle, checkWebBundle } from './check_bundle.ts';

const roots: string[] = [];

/** A bundle directory that looks like a real one: a shell plus client modules. */
const bundleWith = (name: string, files: Readonly<Record<string, string>>): string => {
  const root = mkdtempSync(join(tmpdir(), `native-bundle-${name}-`));
  roots.push(root);
  for (const [relative, contents] of Object.entries(files)) {
    const full = join(root, relative);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
};

const cleanBundle = () =>
  bundleWith('clean', {
    'index.html': '<!doctype html><body>%sveltekit.body%</body>',
    '_app/immutable/entry/app.js': 'export const load = () => [];',
  });

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('a bundle the shell can load', () => {
  test('passes', () => {
    expect(checkBundle(cleanBundle())).toEqual([]);
  });

  test('a missing shell is reported with the command that fixes it', () => {
    const root = bundleWith('no-html', {
      '_app/immutable/entry/app.js': 'export const load = () => [];',
    });
    const [problem, ...rest] = checkBundle(root);

    expect(rest).toEqual([]);
    expect(problem?.code).toBe('no_fallback');
    expect(problem?.remedy).toContain('native:build');
  });

  test('a shell with no code is reported rather than shipped', () => {
    // A build that produced HTML and no client assets opens a blank window, which
    // is not an error anywhere in the pipeline.
    const problems = checkBundle(
      bundleWith('no-assets', { 'index.html': '<!doctype html>' }),
    );

    expect(problems.map((problem) => problem.code)).toEqual(['no_assets']);
  });

  test('an empty directory is a missing build, not a passing check', () => {
    const problems = checkBundle(bundleWith('empty', {}));
    expect(problems.map((problem) => problem.code)).toEqual(['no_output']);
  });
});

describe('what the shipped bundle must not contain', () => {
  // Each marker is planted on its own, because a list where every marker fires on
  // one file cannot tell you whether any single one still works.
  for (const marker of [
    'cloudflare:workers',
    'BETTER_AUTH_SECRET',
    'notes_owner_id_idx',
    'device_codes',
    'email_verified',
    'drizzle-orm',
  ]) {
    test(`refuses ${marker}`, () => {
      const root = bundleWith('leak', {
        'index.html': '<!doctype html>',
        '_app/immutable/entry/app.js': `const x = "${marker}";`,
      });
      const problems = checkBundle(root);

      expect(problems.map((problem) => problem.code)).toContain('server_code_in_bundle');
      expect(problems[0]?.message).toContain(marker);
    });
  }

  test('reports the file, not just the marker', () => {
    // "Which module" is the difference between a fixable report and a hunt.
    const root = bundleWith('which', {
      'index.html': '<!doctype html>',
      '_app/immutable/entry/leak.js': 'const x = "device_codes";',
    });

    expect(checkBundle(root)[0]?.message).toContain('_app/immutable/entry/leak.js');
  });
});

describe('the web bundle', () => {
  test('refuses a native import in the deployed Worker bundle', () => {
    const root = bundleWith('web', {
      '_worker.js': 'import x from "@tauri-apps/api/core";',
    });
    const problems = checkWebBundle(root);

    expect(problems.map((problem) => problem.code)).toEqual(['native_import_in_web']);
    expect(problems[0]?.remedy).toContain('native-bridge');
  });

  test('says nothing when the web bundle has not been built', () => {
    // `apps/frontend/client`'s own `check:bundle` reports a missing build with
    // the right remedy; reporting it here too would name the wrong command.
    expect(checkWebBundle(join(tmpdir(), 'never-built-native-web-fixture'))).toEqual([]);
  });
});
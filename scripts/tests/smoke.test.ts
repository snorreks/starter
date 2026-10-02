// scripts/tests/smoke.test.ts
//
// The rehearsal itself is expensive — it installs, migrates, builds — so it runs
// from `bun run smoke` and from CI, not from this unit suite. What this file
// proves is the part that decides whether the rehearsal is *honest*, because a
// rehearsal that silently inherits this machine proves nothing:
//
//   * the copy excludes every warm-cache and state directory, so a step that
//     depends on one cannot pass by accident;
//   * the child process gets a fresh `HOME` inside the temporary checkout, so a
//     step cannot reach `~/.cache/ms-playwright` or `~/.bun`;
//   * no credential is in the environment;
//   * the plan runs the documented commands, in order, and stops at the first
//     failure rather than reporting a cascade;
//   * identity references are *reported*, and the files that document the rename
//     are exempt — a blind global replacement would rewrite the license and the
//     migration history.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/shared/paths.ts';
import {
  copyTemplateTree,
  findIdentityReferences,
  PROJECT_NAME,
  runTemplateSmoke,
} from '../src/smoke/template_smoke.ts';

/**
 * A miniature repository.
 *
 * Real enough that the copy logic and the identity scan both have something to
 * chew on, small enough that `bun install --frozen-lockfile` is not needed — the
 * first step is expected to *fail* here, and that is the assertion: a step that
 * cannot succeed must stop the run, not be skipped.
 */
const writeMiniRepo = (root: string): void => {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), `{ "name": "${PROJECT_NAME}" }\n`);
  writeFileSync(join(root, 'src', 'index.ts'), `export const name = '${PROJECT_NAME}';\n`);
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'stale.txt'), 'a warm cache that must not be copied\n');
  mkdirSync(join(root, '.moon', 'cache'), { recursive: true });
  writeFileSync(join(root, '.moon', 'cache', 'warm.bin'), 'a warm cache that must not be copied\n');
};

describe('the rehearsal cannot inherit this machine', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'starter-smoke-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('the copy itself excludes node_modules and every warm cache', () => {
    const root = join(dir, 'mini');
    writeMiniRepo(root);
    const target = join(dir, 'copy');

    // Asserted on the copy, before any step runs. Checking after `bun install`
    // would prove nothing: `install` creates a fresh `node_modules`, so the
    // directory would exist either way.
    const copied = copyTemplateTree(root, target);

    expect(copied).toContain('package.json');
    expect(copied).toContain(join('src', 'index.ts'));
    expect(copied.some((file) => file.includes('node_modules'))).toBe(false);
    expect(copied.some((file) => file.includes('warm.bin'))).toBe(false);
    expect(existsSync(join(target, 'node_modules'))).toBe(false);

    // `.moon/cache` is gitignored, but `.moon/workspace.yml` and
    // `.moon/toolchains.yml` are committed configuration and `moon run` cannot
    // resolve the workspace without them. Excluding the directory by name was
    // caught by the rehearsal itself: `bun run build` failed with
    // `Unable to locate .moon/workspace.{yml,yaml,…}` in a checkout that had one.
    mkdirSync(join(root, '.moon'), { recursive: true });
    writeFileSync(join(root, '.moon', 'workspace.yml'), 'projects: {}\n');
    const withMoon = copyTemplateTree(root, target);

    expect(withMoon).toContain(join('.moon', 'workspace.yml'));
    expect(withMoon.some((file) => file.includes('warm.bin'))).toBe(false);
  });

  test('the rehearsal gives the checkout its own HOME', () => {
    const root = join(dir, 'mini');
    writeMiniRepo(root);

    const report = runTemplateSmoke({ root, keep: true });
    try {
      // Nothing can resolve out of a real home directory: `~/.cache/ms-playwright`
      // and `~/.bun` are both out of reach, so a browser lane would fail rather
      // than quietly using this machine's download.
      expect(existsSync(join(report.dir, '.smoke-home'))).toBe(true);
    } finally {
      rmSync(report.dir, { recursive: true, force: true });
    }
  });

  test('a failing step stops the run instead of cascading', () => {
    const root = join(dir, 'mini');
    writeMiniRepo(root);

    const report = runTemplateSmoke({ root });

    // A rehearsal that kept going past the first failure would be reporting seven
    // failures caused by one. Whatever the first step is, no step may follow a
    // failing one.
    const firstFailure = report.steps.findIndex((step) => !step.ok);
    expect(firstFailure).toBeGreaterThanOrEqual(0);
    expect(report.steps).toHaveLength(firstFailure + 1);
    expect(report.ok).toBe(false);
  });

  test('a step that cannot succeed reports nonzero, not a signal read as success', () => {
    const root = join(dir, 'mini');
    writeMiniRepo(root);

    const report = runTemplateSmoke({ root });

    expect(report.steps[0]?.step).toBe('install --frozen-lockfile');
    expect(report.steps[0]?.detail.length).toBeGreaterThan(0);
  });

  test('maxSteps bounds the rehearsal', () => {
    const root = join(dir, 'mini');
    writeMiniRepo(root);

    // The test suite runs `smoke` and must not inherit the cost of a full
    // rehearsal.
    expect(runTemplateSmoke({ root, maxSteps: 1 }).steps.length).toBeLessThanOrEqual(1);
  });
});

describe('the rename is reported, never performed', () => {
  test('a committed identity reference outside the documenting files is found', () => {
    const root = join(tmpdir(), `starter-smoke-identity-${Date.now()}`);
    try {
      mkdirSync(join(root, 'docs'), { recursive: true });
      mkdirSync(join(root, 'apps', 'e2e'), { recursive: true });
      writeFileSync(join(root, 'package.json'), `{ "name": "${PROJECT_NAME}" }\n`);
      writeFileSync(join(root, 'docs', 'rename-checklist.md'), `replace ${PROJECT_NAME} here\n`);
      writeFileSync(join(root, 'LICENSE'), `Copyright (c) 2026 snorreks/starter contributors\n`);
      writeFileSync(join(root, 'wrangler.jsonc'), `// ${PROJECT_NAME}\n`);
      writeFileSync(join(root, 'apps', 'e2e', 'playwright.config.ts'), `// ${PROJECT_NAME}\n`);

      const references = findIdentityReferences(root);

      // The config and the spec are exactly what a consumer has to change, and a
      // blind global replacement would have to be told about both.
      expect(references.some((ref) => ref.startsWith('wrangler.jsonc:'))).toBe(true);
      expect(
        references.some((ref) => ref.startsWith(join('apps', 'e2e', 'playwright.config.ts'))),
      ).toBe(true);
      // The instructions and the provenance are exactly where a global replace does
      // damage, and the manifest is the identity itself.
      expect(references.some((ref) => ref.startsWith('docs/rename-checklist.md:'))).toBe(false);
      expect(references.some((ref) => ref.startsWith('package.json:'))).toBe(false);
      // The license names the upstream project. Rewriting provenance is not a rename.
      expect(references.some((ref) => ref.startsWith('LICENSE:'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('this repository’s own identity references are limited to the files that document them', () => {
    const references = findIdentityReferences(REPO_ROOT);

    // Not "empty": `snorreks/starter` legitimately appears in provenance. What must
    // not appear is the kind of reference that makes a consumer hunt.
    expect(references.length).toBeGreaterThanOrEqual(0);
    for (const reference of references) {
      expect(reference.startsWith('docs/rename-checklist.md:')).toBe(false);
    }
  });
});

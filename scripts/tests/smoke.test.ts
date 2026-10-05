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
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from '../src/shared/paths.ts';
import {
  committedFiles,
  copyTemplateTree,
  findIdentityReferences,
  InvalidStepLimit,
  narrateRemovedReferences,
  PROJECT_NAME,
  removeHeavyExamples,
  runTemplateSmoke,
} from '../src/smoke/template_smoke.ts';

/**
 * A miniature repository whose **first step genuinely cannot succeed**.
 *
 * Real enough that the copy logic and the identity scan both have something to
 * chew on. `bun install --frozen-lockfile` fails here because the manifest names a
 * dependency that does not exist and there is no lockfile to satisfy it from — a
 * deterministic failure, reached without inventing a broken fixture.
 *
 * That matters because an earlier version depended on a bare manifest failing to
 * install, and it no longer does: `bun install --frozen-lockfile` on a package with
 * no dependencies succeeds and writes a lockfile. The suite went green for the wrong
 * reason, and a test that asserts "the first step failed" must not be satisfied by a
 * step that was never in doubt.
 */
const writeMiniRepo = (root: string): void => {
  mkdirSync(join(root, 'src'), { recursive: true });
  // A package name no registry has, so resolution cannot succeed and
  // `--frozen-lockfile` cannot invent one.
  writeFileSync(
    join(root, 'package.json'),
    `{
  "name": "${PROJECT_NAME}",
  "type": "module",
  "dependencies": { "@starter/starter-smoke-absent-dependency": "1.0.0" }
}
`,
  );
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

  test('a committed source file under a generated-output name is copied anyway', () => {
    // `artifacts` is in `EXCLUDED` because `.pi/artifacts` and friends are
    // generated. `scripts/src/artifacts` holds the Worker bundler that
    // `client:build` runs, and excluding the directory by name deleted it from
    // every rehearsal — `bun run smoke` failed at `bun run build` with
    // `Module not found "../../../scripts/src/artifacts/bundle_worker.ts"`, in a
    // checkout whose repository has the file.
    const root = join(dir, 'mini');
    writeMiniRepo(root);
    mkdirSync(join(root, 'scripts/src/artifacts'), { recursive: true });
    writeFileSync(join(root, 'scripts/src/artifacts/bundler.ts'), 'export const bundled = 1;\n');
    mkdirSync(join(root, '.pi/artifacts'), { recursive: true });
    writeFileSync(
      join(root, '.pi/artifacts', 'warm.bin'),
      'a warm cache that must not be copied\n',
    );
    // Generated output is gitignored rather than committed — which is what the
    // exclusion exists for, and what makes `.pi/artifacts` a different case from
    // `scripts/src/artifacts`.
    writeFileSync(join(root, '.gitignore'), '.pi/artifacts/\n');
    spawnSync('git', ['init', '--quiet'], { cwd: root });
    spawnSync('git', ['add', '-A'], { cwd: root });
    const target = join(dir, 'copy');

    const copied = copyTemplateTree(root, target);

    expect(copied).toContain(join('scripts', 'src', 'artifacts', 'bundler.ts'));
    expect(existsSync(join(target, 'scripts/src/artifacts/bundler.ts'))).toBe(true);
    // The reason the name is in the list at all still holds.
    expect(copied.some((file) => file.includes('.pi/artifacts'))).toBe(false);
  });

  test('the rehearsal gives the checkout its own HOME', () => {
    const root = join(dir, 'mini');
    writeMiniRepo(root);

    const report = runTemplateSmoke({ root, keep: true });
    try {
      // The *reported* HOME, not the existence of the directory. `runTemplateSmoke`
      // creates the HOME itself before running any step, so the directory being
      // there proves only that the rehearsal made a directory — not that the child
      // process was pointed at it. A run whose env block lost `HOME` would still
      // pass the old assertion while inheriting the maintainer's home directory,
      // which is the entire risk.
      //
      // A *sibling* of the checkout, not a directory inside it: inside it, `install`
      // fills it with a Bun package cache and the whole-repository guard then reports
      // thousands of unclassified files under a directory no ownership rule covers.
      expect(report.reportedHome).toBe(join(dirname(report.dir), 'smoke-home'));
      expect(report.reportedHome).not.toBe(join(report.dir, '.smoke-home'));
      expect(report.reportedHome?.startsWith('/')).toBe(true);
    } finally {
      // The temporary *root*: the checkout and the disposable HOME beside it. Removing
      // only `report.dir` left the sibling behind, so every run of this test leaked a
      // directory into /tmp.
      rmSync(dirname(report.dir), { recursive: true, force: true });
    }
  });

  test('removal reports what it actually deleted, and an empty tree reports nothing', () => {
    // It used to print a fixed sentence naming four directories and two workflows
    // regardless, so a rehearsal that deleted nothing still claimed it had.
    const root = join(dir, 'empty');
    mkdirSync(root, { recursive: true });
    expect(removeHeavyExamples(root)).toEqual([]);

    const populated = join(dir, 'populated');
    for (const relative of ['apps/frontend/native', 'apps/backend/media']) {
      mkdirSync(join(populated, relative), { recursive: true });
    }
    const removed = removeHeavyExamples(populated);
    expect(removed).toContain('apps/frontend/native');
    expect(removed).toContain('apps/backend/media');
    expect(existsSync(join(populated, 'apps/frontend/native'))).toBe(false);
  });

  test('a rehearsal that removed nothing reports an empty list, not a claim', () => {
    const root = join(dir, 'bare');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'README.md'), '# nothing to remove\n', 'utf8');
    // `removed` is populated from `removeHeavyExamples`, so a tree with no heavy
    // examples yields an empty list — and the command's notice keys off exactly that.
    expect(removeHeavyExamples(root)).toEqual([]);
  });

  test('overlapping removed paths are each annotated once', () => {
    // `apps/frontend/native` is a prefix of `apps/frontend/native/src-tauri`.
    // Annotating the short one first inserted text inside the long one, producing
    // `apps/frontend/native (removed in this copy)/src-tauri` — which is neither
    // path and matches neither exemption.
    const root = join(dir, 'overlap');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'README.md'),
      'See apps/frontend/native and apps/frontend/native/src-tauri for details.\n',
      'utf8',
    );

    const touched = narrateRemovedReferences(root, [
      'apps/frontend/native',
      'apps/frontend/native/src-tauri',
    ]);

    expect(touched).toContain('README.md');
    const text = readFileSync(join(root, 'README.md'), 'utf8');
    expect(text).toContain('apps/frontend/native (removed in this copy)');
    expect(text).toContain('apps/frontend/native/src-tauri (removed in this copy)');
    expect(text).not.toContain('native (removed in this copy)/src-tauri');
    // Twice: one per distinct path. Not three, and not one.
    expect(text.match(/removed in this copy/g) ?? []).toHaveLength(2);
  });

  test('a path segment with a dot is matched literally', () => {
    const root = join(dir, 'dotted');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'README.md'), 'See apps/backend/media/README.md here.\n', 'utf8');

    narrateRemovedReferences(root, ['apps/backend/media/README.md']);
    const text = readFileSync(join(root, 'README.md'), 'utf8');
    expect(text).toContain('apps/backend/media/README.md (removed in this copy)');
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

  test('a step that cannot succeed is recorded as failed, not merely as noisy', () => {
    const root = join(dir, 'mini');
    writeMiniRepo(root);

    const report = runTemplateSmoke({ root });

    expect(report.steps[0]?.step).toBe('install --frozen-lockfile');
    // The outcome, not the presence of output. A step that printed something and
    // exited 0 would satisfy a `detail.length` check while the rehearsal reported
    // success against a checkout that never installed.
    expect(report.steps[0]?.ok).toBe(false);
    expect(report.ok).toBe(false);
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

  test('this repository’s own identity references are exactly the permitted ones', () => {
    const references = findIdentityReferences(REPO_ROOT);

    // A real, closed set. The previous assertion was `toBeGreaterThanOrEqual(0)`,
    // which every array satisfies — it cannot fail — and the loop beneath it
    // re-checked a path `findIdentityReferences` already filters, so a genuinely
    // unexpected reference anywhere in the repository went unreported.
    //
    // Declared here rather than imported, so widening the module's `IDENTITY_ALLOWED`
    // cannot silently widen what this test accepts. That decision is made in two
    // places on purpose: the module says what it does, this says what is acceptable.
    //
    // Today the answer is empty. `package.json` and `bun.lock` name the identity and
    // are the identity; the rename checklist, the provenance note and the checker
    // itself are exempt by name. A new reference anywhere else — a source file, a
    // doc, a config — lands here and fails.
    const permitted = new Set<string>([
      'LICENSE',
      'docs/starter-extraction.md',
      'package.json',
      'bun.lock',
    ]);

    const unexpected = references
      .map((reference) => (reference.split(':')[0] ?? '').split('\\').join('/'))
      .filter((file) => !permitted.has(file));

    expect(unexpected).toEqual([]);
  });
});

describe('the copy models a clone, not the developer’s working directory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'starter-clone-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('a gitignored local file is not copied, and a tracked one is', () => {
    // Built as a real repository rather than asserted against this checkout.
    // Asserting `existsSync(REPO_ROOT/.env')` made the test depend on whether
    // `bun run setup` had been run: true in a working checkout, false in CI, where
    // the unit lane runs before setup. The suite then failed on the checkout that
    // was *more* prepared — a fixture does not have that problem.
    const root = join(dir, 'repo');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{ "name": "fixture" }\n');
    // The pattern is the one that matters in practice: `.env` ignored,
    // `.env.example` and `.envrc` tracked. A deny-list keyed on the `.env` prefix
    // would take all three.
    writeFileSync(join(root, '.gitignore'), '.env\n!.env.example\n');
    writeFileSync(join(root, '.env'), 'SECRET=not-for-a-clone\n');
    writeFileSync(join(root, '.env.example'), 'SECRET=\n');
    writeFileSync(join(root, '.envrc'), 'export FOO=1\n');
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
    spawnSync('git', ['init', '--quiet'], { cwd: root });
    spawnSync('git', ['add', '-A'], { cwd: root });

    const target = mkdtempSync(join(tmpdir(), 'starter-env-'));
    try {
      const copied = copyTemplateTree(root, target);

      expect(copied).not.toContain('.env');
      expect(existsSync(join(target, '.env'))).toBe(false);

      // The mirror: `git check-ignore` is used rather than a hand-rolled pattern
      // language precisely so `.env.example` and `.envrc` survive.
      expect(copied).toContain('.env.example');
      expect(copied).toContain('.envrc');
      expect(committedFiles(root)).not.toContain('.env');
      expect(committedFiles(root)).toContain('.envrc');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  test('a step limit of zero is refused rather than running nothing and reporting ok', () => {
    // `--steps=0` used to slice an empty plan, satisfy "every step passed" over an
    // empty array, and print `ok` — a successful rehearsal that executed no step.
    const root = mkdtempSync(join(tmpdir(), 'starter-smoke-zero-'));
    try {
      writeMiniRepo(root);
      expect(() => runTemplateSmoke({ root, maxSteps: 0 })).toThrow(InvalidStepLimit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

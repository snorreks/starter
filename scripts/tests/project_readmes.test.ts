// scripts/tests/project_readmes.test.ts
//
// The README coverage guard, proved against disposable trees.
//
// The claim this file exists to defend is narrow and is stated here because it is the
// whole point: **the set of projects that owe a README is discovered, never listed.**
// Five of this repository's projects had no README while the four that did were the
// four somebody was already reading. A guard built from a list would have reported
// the same clean tree the day `packages/frontend/features` was created.
//
// So the negative controls below add a project through each declaration that can
// create one — the root manifest's globs, `.moon/workspace.yml`, a first-party
// `Cargo.toml` — and assert that each is reported. The generated-tree controls assert
// the opposite: a Cargo manifest under `src-tauri/target` and a package under
// `.moon/cache` are not projects, and a guard that cannot tell the difference is a
// guard that will be switched off the first time somebody runs `bun run build`.

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Violation } from '../src/guards/boundary.ts';
import { guardProjectReadmes } from '../src/guards/guard_readmes.ts';
import { discoverProjects } from '../src/guards/project_discovery.ts';
import { REPO_ROOT } from '../src/shared/paths.ts';

const created: string[] = [];

/** A README that satisfies all five obligations, in the most ordinary wording. */
const CONFORMANT_README = `# @starter/thing

## Purpose

A package that runs in a browser and in workerd.

## Setup and configuration

Nothing to configure; there is no environment variable.

## Commands

From \`packages/shared/thing\`:

\`\`\`bash
bun run test
\`\`\`

## Tests and artifacts

\`bun test\` covers the refusals. The artifact is the source.

## Boundaries and documentation

May import \`@starter/schemas\`. See [docs/architecture.md](../../docs/architecture.md).
`;

interface Tree {
  readonly [path: string]: string;
}

const makeTree = (files: Tree): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-readme-'));
  created.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }
  return root;
};

/**
 * A tree with one Bun workspace, one Moon-only project and one first-party crate,
 * each documented — the positive control every negative below is measured against.
 */
const CONFORMANT: Tree = {
  'README.md': CONFORMANT_README.replace('@starter/thing', 'the repository'),
  'package.json': JSON.stringify({
    name: 'fixture',
    version: '0.1.0',
    private: true,
    workspaces: ['packages/shared/*'],
  }),
  'packages/shared/thing/package.json': JSON.stringify({ name: '@starter/thing' }),
  'packages/shared/thing/README.md': CONFORMANT_README,
  '.moon/workspace.yml': "projects:\n  tool: 'tools/thing'\n",
  'tools/thing/README.md': CONFORMANT_README,
  'crates/processor/Cargo.toml': '[package]\nname = "processor"\nversion = "0.1.0"\n',
  'crates/processor/README.md': CONFORMANT_README,
};

const run = (files: Tree): readonly Violation[] => guardProjectReadmes(makeTree(files)).violations;

const firstOf = (violations: readonly Violation[], rule: string): Violation | undefined =>
  violations.find((violation) => violation.rule === rule);

afterAll(() => {
  for (const root of created) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── discovery ────────────────────────────────────────────────────────────────

describe('readmes: which directories owe a README', () => {
  test('reports nothing for a tree where every discovered project is documented', () => {
    // The positive control. Without it, "the guard found nothing" and "the guard
    // found nothing wrong" would be the same outcome, and every case below would be
    // satisfiable by a guard that returns no violations ever.
    expect(run(CONFORMANT)).toEqual([]);
  });

  test('finds projects through each of the three declarations', () => {
    // The property that replaces the list. Each source is exercised on its own, and
    // the answer names the declaration that found the project — which is what makes
    // the diagnostic actionable when the wrong thing is reported.
    const found = discoverProjects(makeTree(CONFORMANT));
    expect(found.map((project) => [project.dir, project.name])).toEqual([
      ['.', 'fixture'],
      ['crates/processor', 'processor'],
      ['packages/shared/thing', '@starter/thing'],
      ['tools/thing', 'tool'],
    ]);
    expect(found.find((project) => project.dir === 'packages/shared/thing')?.sources).toEqual([
      'bun-workspace',
    ]);
    expect(found.find((project) => project.dir === 'tools/thing')?.sources).toEqual([
      'moon-project',
    ]);
    expect(found.find((project) => project.dir === 'crates/processor')?.sources).toEqual([
      'cargo-crate',
    ]);
  });

  test('merges the declarations that agree about one directory', () => {
    // A Moon project that is also a Bun workspace is one project, and it is a stronger
    // obligation than either alone. Two reports for one README would be noise.
    const root = makeTree({
      ...CONFORMANT,
      '.moon/workspace.yml': "projects:\n  thing: 'packages/shared/thing'\n",
    });
    const project = discoverProjects(root).find((entry) => entry.dir === 'packages/shared/thing');
    expect(project?.sources).toEqual(['bun-workspace', 'moon-project']);
    expect(guardProjectReadmes(root).violations).toEqual([]);
  });
});

// ── negative controls: a new project cannot escape the obligation ─────────────

describe('readmes: a new project owes a README whichever way it appeared', () => {
  test('reports a Bun workspace added to the globs', () => {
    const violations = run({
      ...CONFORMANT,
      'packages/shared/added/package.json': JSON.stringify({ name: '@starter/added' }),
    });

    const violation = firstOf(violations, 'project-readme-missing');
    expect(violation, 'expected project-readme-missing').toBeDefined();
    expect(violation?.file).toBe('packages/shared/added/README.md');
    expect(violation?.message).toContain('the root package.json workspaces globs');
  });

  test('reports a Moon project with no package.json at all', () => {
    // The Rust-backed project shape: a Moon project that is not a Bun workspace. A
    // guard that only read `package.json` would never see it.
    const violations = run({
      ...CONFORMANT,
      '.moon/workspace.yml': "projects:\n  tool: 'tools/thing'\n  crate: 'crates/encoder'\n",
    });

    expect(firstOf(violations, 'project-readme-missing')?.file).toBe('crates/encoder/README.md');
  });

  test('reports a first-party Cargo crate', () => {
    const violations = run({
      ...CONFORMANT,
      'apps/backend/media/Cargo.toml':
        '[package]\nname = "media"\nversion = "0.1.0"\n\n[dependencies]\ntauri = "2"\n',
      'apps/backend/media/src/main.rs': 'fn main() {}\n',
    });

    const violation = firstOf(violations, 'project-readme-missing');
    expect(violation?.file).toBe('apps/backend/media/README.md');
    expect(violation?.message).toContain('a first-party Cargo.toml');
  });

  test('reports a README that answers none of the questions', () => {
    // The second failure mode, and the one a `test -f README.md` check cannot see. A
    // title and a sentence is what most of this repository's package READMEs were.
    const violations = run({
      ...CONFORMANT,
      'packages/shared/thing/README.md': '# @starter/thing\n\nPortable helpers.\n',
    });

    const violation = firstOf(violations, 'project-readme-incomplete');
    expect(violation, 'expected project-readme-incomplete').toBeDefined();
    expect(violation?.file).toBe('packages/shared/thing/README.md');
    for (const id of ['purpose', 'setup', 'commands', 'validation', 'boundaries']) {
      expect(violation?.message).toContain(id);
    }
  });

  test('accepts a README whose wording is its own', () => {
    // The other half of "don't require identical wording". Same five answers, none of
    // them the headings this repository's own READMEs use.
    const violations = run({
      ...CONFORMANT,
      'packages/shared/thing/README.md': `# thing

## Overview
Runs in three runtimes.

## Environment
No variables.

## How to run
From here: \`bun run test\`.

## Verifying
\`bun test\`; the build output is the source.

## Dependencies
Only \`@starter/schemas\`. See the architecture guide.
`,
    });

    expect(violations).toEqual([]);
  });
});

// ── the generation policy ────────────────────────────────────────────────────

describe('readmes: generated and vendored trees are not projects', () => {
  test('ignores a Cargo manifest under a Cargo build directory', () => {
    // Cargo writes `Cargo.toml` files of its own into `target/`. Treating one as a
    // crate would demand a hand-maintained README for a build artifact, which is the
    // failure that makes a guard get deleted rather than fixed.
    const violations = run({
      ...CONFORMANT,
      'apps/frontend/native/src-tauri/Cargo.toml': '[package]\nname = "shell"\n',
      'apps/frontend/native/src-tauri/README.md': CONFORMANT_README,
      'apps/frontend/native/src-tauri/target/debug/build/probe-1/out/Cargo.toml':
        '[package]\nname = "generated-probe"\n',
    });

    expect(violations).toEqual([]);
  });

  test('ignores a generated platform project and a workspace cache', () => {
    // The two generated trees that look most like projects: Tauri regenerates the
    // Android and Xcode projects, and Moon creates its cache directory on the first
    // cached task. Both are declared in `GENERATED_TREES` with a reason.
    const violations = run({
      ...CONFORMANT,
      'apps/frontend/native/src-tauri/gen/android/settings/package.json':
        '{"name":"android-settings"}\n',
      'apps/frontend/native/src-tauri/gen/apple/project.yml': 'name: native\n',
      '.moon/cache/hash/task.json': '{}',
    });

    expect(violations).toEqual([]);
    expect(discoverProjects(makeTree(CONFORMANT)).map((project) => project.dir)).not.toContain(
      'apps/frontend/native/src-tauri/gen/android/settings',
    );
  });

  test('still demands a README for the crate that owns the generated tree', () => {
    // Excluding a generated tree must not exclude its owner. `src-tauri` is a crate
    // somebody maintains; `src-tauri/gen/android` is not.
    const violations = run({
      ...CONFORMANT,
      'apps/frontend/native/src-tauri/Cargo.toml': '[package]\nname = "shell"\n',
      'apps/frontend/native/src-tauri/gen/android/settings/package.json': '{"name":"gen"}\n',
    });

    expect(firstOf(violations, 'project-readme-missing')?.file).toBe(
      'apps/frontend/native/src-tauri/README.md',
    );
  });

  test('discovers projects on a tree where no build output exists', () => {
    // A fresh checkout: no `.moon/cache`, no `node_modules`, no `dist`, no `.svelte-kit`.
    // Discovery walks the filesystem, so anything that required one of those to be
    // there would fail on the one checkout a new contributor is guaranteed to have.
    // The generated trees are declared as *generated*; they are not prerequisites.
    const root = makeTree(CONFORMANT);
    for (const absent of ['.moon/cache', 'node_modules', 'dist', '.svelte-kit']) {
      expect(existsSync(join(root, absent))).toBe(false);
    }
    expect(guardProjectReadmes(root).violations).toEqual([]);
  });
});

// ── the real command, and the real repository ─────────────────────────────────

describe('readmes: the guard command and the live tree', () => {
  const cli = (root: string): { code: number; stdout: string } => {
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/cli.ts', 'guard', '--only', 'project-readme', '--root', root],
      cwd: join(REPO_ROOT, 'scripts'),
    });
    return { code: result.exitCode, stdout: result.stdout.toString() };
  };

  test('exits nonzero and names the path when a new project has no README', () => {
    const root = makeTree({
      ...CONFORMANT,
      'packages/shared/added/package.json': JSON.stringify({ name: '@starter/added' }),
    });

    const result = cli(root);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('project-readme-missing');
    expect(result.stdout).toContain('packages/shared/added/README.md');
  });

  test('exits zero on a documented tree', () => {
    expect(cli(makeTree(CONFORMANT)).code).toBe(0);
  });

  test('every first-party project in this repository is documented today', () => {
    // The property the review asked for, asserted against the live tree: the five
    // projects that had no README now have one that answers all five questions, even
    // though none of them changed any runtime code.
    expect(guardProjectReadmes(REPO_ROOT).violations).toEqual([]);

    const directories = discoverProjects(REPO_ROOT).map((project) => project.dir);
    for (const expected of [
      '.',
      '.pi',
      'apps/e2e',
      'apps/frontend/client',
      'packages/backend/auth',
      'packages/backend/database',
      'packages/frontend/ui',
      'packages/shared/logger',
      'packages/shared/schemas',
      'packages/shared/utils',
      'scripts',
    ]) {
      expect(directories, `expected ${expected} to be discovered`).toContain(expected);
    }
  });
});

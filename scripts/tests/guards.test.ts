// scripts/src/lib/guards/guards.test.ts
//
// The guards, tested against fixtures rather than against the repository.
//
// Two reasons. A guard that has only ever run clean is untested: it may report
// `ok` because it reads nothing. And a guard run against the live tree cannot be
// shown to *fail*, because making it fail would require breaking the repository
// to prove it. Each test here writes a throwaway tree under a temp directory.
//
// The `source-is-tracked` cases are not hypothetical. An unanchored `logs/`
// pattern in `.gitignore` silently excluded all eight files of
// `scripts/src/lib/logs/` — the log CLI and its 31 tests — while `git status`
// stayed clean and every test passed. That is what Rule 4 exists to catch.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  guardNoLeftovers,
  guardRequestState,
  guardSourceIsTracked,
  guardWorkspaceBoundary,
} from '../guards/boundary.ts';

const created: string[] = [];

/** A throwaway repository-shaped tree. */
const makeTree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-guard-'));
  created.push(root);

  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf8');
  }

  return root;
};

afterAll(() => {
  for (const root of created) {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * Import lines, assembled from parts.
 *
 * The boundary guard scans text, so a fixture that spelled `@starter/database`
 * out in full would be read as this file importing it — and this file would then
 * fail the very rule it is testing. Assembling keeps the fixture honest and the
 * guard clean without an exemption that would weaken it everywhere else.
 */
const pkg = (name: string): string => `@starter/${name}`;
const importLine = (specifier: string): string => `import { thing } from '${specifier}';`;
const importComment = (specifier: string): string => `// import { thing } from '${specifier}';`;

describe('workspace-boundary', () => {
  test('allows a layer to import a layer it depends on', () => {
    const root = makeTree({
      'apps/backend/api/src/lib/db.ts': `${importLine(pkg('database'))}\n`,
    });

    const result = guardWorkspaceBoundary(root);
    expect(result.violations).toEqual([]);
  });

  test('rejects the API importing Svelte component code', () => {
    // The split between `client` and `api` exists for this: `@starter/ui` is
    // Svelte, and a Worker has no DOM to compile it against.
    const root = makeTree({
      'apps/backend/api/src/lib/render.ts': `${importLine(pkg('ui'))}\n`,
    });

    const result = guardWorkspaceBoundary(root);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).toContain(pkg('ui'));
  });

  test('rejects the client importing a server library', () => {
    // And symmetrically: `drizzle-orm` in a browser bundle fails on the first
    // query, in development, with a confusing error.
    const root = makeTree({
      'apps/frontend/client/src/lib/db.ts': `${importLine(pkg('database'))}\n`,
    });

    const result = guardWorkspaceBoundary(root);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.message).toContain(pkg('database'));
  });

  test('counts a subpath import as the package it belongs to', () => {
    // `@starter/schemas/notes` is the schemas package, not a separate one.
    const root = makeTree({
      'packages/backend/auth/src/session.ts': `${importLine(pkg('schemas/auth'))}\n`,
    });

    expect(guardWorkspaceBoundary(root).violations).toEqual([]);
  });

  test('rejects shared code reaching sideways into a plane', () => {
    // The rule that keeps drizzle-orm and svelte out of shared bundles.
    const root = makeTree({
      'packages/shared/utils/src/db.ts': `${importLine(pkg('database'))}\n`,
    });

    const result = guardWorkspaceBoundary(root);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.file).toContain('packages/shared/utils');
  });

  test('ignores a specifier mentioned only in a comment', () => {
    const root = makeTree({
      'apps/backend/api/src/lib/render.ts': `${importComment(pkg('ui'))}\nexport const a = 1;\n`,
    });

    expect(guardWorkspaceBoundary(root).violations).toEqual([]);
  });

  test('every result declares a zero baseline', () => {
    // Guards are invariants. A baseline count is how a failure learns to hide.
    const root = makeTree({ 'apps/backend/api/src/lib/a.ts': 'export const a = 1;\n' });

    expect(guardWorkspaceBoundary(root).baselineCount).toBe(0);
    expect(guardRequestState(root).baselineCount).toBe(0);
    expect(guardNoLeftovers(root).baselineCount).toBe(0);
    expect(guardSourceIsTracked(root).baselineCount).toBe(0);
  });
});

describe('request-state', () => {
  test('flags a module-level env binding', () => {
    const root = makeTree({
      'apps/backend/api/src/lib/context.ts': 'let currentEnv: ApiEnv | undefined;\n',
    });

    expect(guardRequestState(root).violations).toHaveLength(1);
  });

  test('flags a setter that stashes request state on the module', () => {
    const root = makeTree({
      'apps/backend/api/src/lib/context.ts':
        'export const setEnvForRequest = (env: unknown): void => {\n  stored = env;\n};\n',
    });

    expect(guardRequestState(root).violations).toHaveLength(1);
  });

  test('allows a per-request value built inside a handler', () => {
    const root = makeTree({
      'apps/backend/api/src/lib/context.ts':
        'export const buildRequestContext = (request: Request, env: ApiEnv) => {\n' +
        '  const user = resolveUser(request, env);\n' +
        '  return { user, traceId: crypto.randomUUID() };\n' +
        '};\n',
    });

    expect(guardRequestState(root).violations).toEqual([]);
  });

  test('does not fire on an immutable module-level binding', () => {
    const root = makeTree({
      'apps/backend/api/src/lib/notes.ts': 'const MAX_BODY_BYTES = 64_000;\n',
    });

    expect(guardRequestState(root).violations).toEqual([]);
  });
});

describe('no-leftovers', () => {
  test('flags console.log in production source', () => {
    const root = makeTree({
      'apps/backend/api/src/lib/notes.ts': "export const a = () => console.log('hi');\n",
    });

    expect(guardNoLeftovers(root).violations).toHaveLength(1);
  });

  test('flags a bare debugger statement', () => {
    const root = makeTree({
      'apps/backend/api/src/lib/notes.ts': 'export const a = () => {\n  debugger;\n};\n',
    });

    expect(guardNoLeftovers(root).violations).toHaveLength(1);
  });

  test('allows a debugger inside a string, which is not a statement', () => {
    // An unanchored /\bdebugger\b/ matches this, and then the guard fails on its
    // own pattern literal.
    const root = makeTree({
      'apps/backend/api/src/lib/notes.ts':
        "export const hint = 'set a debugger breakpoint here';\n",
    });

    expect(guardNoLeftovers(root).violations).toEqual([]);
  });

  test('allows console output in a test file', () => {
    const root = makeTree({
      'apps/backend/api/tests/notes.test.ts': "console.log('diagnostic');\n",
    });

    expect(guardNoLeftovers(root).violations).toEqual([]);
  });
});

describe('source-is-tracked', () => {
  test('flags source under a directory an unanchored pattern swallows', () => {
    // The bug this rule was added for, exactly as it occurred.
    const root = makeTree({
      '.gitignore': 'node_modules/\nlogs/\n*.log\n',
      'scripts/src/lib/logs/cli.ts': 'export const cli = (): void => {};\n',
    });

    const result = guardSourceIsTracked(root);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.file).toBe(join('scripts', 'src', 'lib', 'logs', 'cli.ts'));
    expect(result.violations[0]?.message).toContain('line 2');
  });

  test('accepts the same pattern anchored to the root', () => {
    const root = makeTree({
      '.gitignore': '/logs/\n',
      'scripts/src/lib/logs/cli.ts': 'export const cli = (): void => {};\n',
    });

    expect(guardSourceIsTracked(root).violations).toEqual([]);
  });

  test('flags a source file excluded by name', () => {
    const root = makeTree({
      '.gitignore': 'secret_notes.ts\n',
      'apps/backend/api/src/lib/secret_notes.ts': 'export const a = 1;\n',
    });

    expect(guardSourceIsTracked(root).violations).toHaveLength(1);
  });

  test('respects a negation that re-includes a path', () => {
    const root = makeTree({
      '.gitignore': '*.log.ts\n!keep.log.ts\n',
      'apps/backend/api/src/lib/keep.log.ts': 'export const a = 1;\n',
    });

    expect(guardSourceIsTracked(root).violations).toEqual([]);
  });

  test('reports the last matching rule, as git does', () => {
    const root = makeTree({
      '.gitignore': '/src/lib/gone.ts\n!src/lib/gone.ts\n',
      'apps/backend/api/src/lib/gone.ts': 'export const a = 1;\n',
    });

    expect(guardSourceIsTracked(root).violations).toEqual([]);
  });

  test('does not match a glob across a path separator', () => {
    // `*.log` matches `build.log` but not `build/log.ts`: a `*` in git does not
    // span directories, and a version that did would hide a whole tree.
    const root = makeTree({
      '.gitignore': '*.log\n',
      'apps/backend/api/src/lib/build/notes.ts': 'export const a = 1;\n',
    });

    expect(guardSourceIsTracked(root).violations).toEqual([]);
  });

  test('ignores comments and blank lines', () => {
    const root = makeTree({
      '.gitignore': '# logs/\n\n   \n',
      'scripts/src/lib/logs/cli.ts': 'export const cli = (): void => {};\n',
    });

    expect(guardSourceIsTracked(root).violations).toEqual([]);
  });

  test('reports nothing when there is no .gitignore', () => {
    // A fresh copy is checked before `git init`; absence of the file is not a
    // violation.
    const root = makeTree({
      'scripts/src/lib/logs/cli.ts': 'export const cli = (): void => {};\n',
    });

    expect(guardSourceIsTracked(root).violations).toEqual([]);
  });

  test('checks apps and packages, not just scripts', () => {
    const root = makeTree({
      '.gitignore': 'shared/\n',
      'packages/shared/schemas/src/index.ts': 'export const a = 1;\n',
    });

    expect(guardSourceIsTracked(root).violations).toHaveLength(1);
  });
});

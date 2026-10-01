// scripts/tests/guards.test.ts
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
// `scripts/src/logs/` — the log adapters and their tests — while `git status`
// stayed clean and every test passed. That is what Rule 4 exists to catch.

import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  guardDocumentedPaths,
  guardNoLeftovers,
  guardRequestState,
  guardSourceIsTracked,
  guardVersionMirrors,
  guardWorkspaceBoundary,
} from '../src/guards/boundary.ts';
import { REPO_ROOT } from '../src/shared/paths.ts';

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

describe('version-mirrors', () => {
  // The drift below is not hypothetical: `.bun-version` said 1.4.0 while CI
  // pinned 1.4.2, and CI's `bun install --frozen-lockfile` failed with a message
  // about the lockfile that named nothing useful. Neither file was wrong alone.
  const pins = (bun: string): string => `{"bun":"${bun}","playwright":{"browsers":["chromium"]}}`;

  test('accepts a mirror that agrees with the pin', () => {
    const root = makeTree({
      'config/toolchain.json': pins('1.4.2'),
      '.bun-version': '1.4.2\n',
    });

    expect(guardVersionMirrors(root).violations).toEqual([]);
  });

  test('rejects the exact drift that shipped: .bun-version behind CI', () => {
    const root = makeTree({
      'config/toolchain.json': pins('1.4.2'),
      '.bun-version': '1.4.0\n',
    });

    const violations = guardVersionMirrors(root).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('.bun-version');
    // The message must name the version, since the whole point is that the
    // original failure named only the lockfile.
    expect(violations[0].message).toContain('1.4.0');
    expect(violations[0].message).toContain('1.4.2');
  });

  test('reports a missing pin file rather than passing silently', () => {
    // A guard that returns zero violations because it found nothing to read is
    // the failure mode this whole suite exists to prevent.
    const root = makeTree({ '.bun-version': '1.4.2\n' });

    expect(guardVersionMirrors(root).violations).toHaveLength(1);
  });

  test('reports unparseable JSON rather than passing silently', () => {
    const root = makeTree({
      'config/toolchain.json': '{ not json',
      '.bun-version': '1.4.2\n',
    });

    expect(guardVersionMirrors(root).violations.length).toBeGreaterThan(0);
  });

  test('tolerates trailing whitespace in the mirror', () => {
    // Editors and generators add a newline. Treating that as drift would train
    // people to ignore the guard, which is how a real drift goes unnoticed.
    const root = makeTree({
      'config/toolchain.json': pins('1.4.2'),
      '.bun-version': '  1.4.2  \n',
    });

    expect(guardVersionMirrors(root).violations).toEqual([]);
  });

  // GitHub Actions cannot read a file into a workflow-level `env:`, so CI holds a
  // literal. That makes it a second source of truth, and it is the one that was
  // already wrong when the pin said 1.4.0.
  const workflow = (version: string | null): string =>
    version === null
      ? 'jobs:\n  check:\n    runs-on: ubuntu-latest\n'
      : `env:\n  BUN_VERSION: '${version}'\n`;

  test('accepts a CI literal that agrees with the pin', () => {
    const root = makeTree({
      'config/toolchain.json': pins('1.4.2'),
      '.bun-version': '1.4.2\n',
      '.github/workflows/ci.yml': workflow('1.4.2'),
    });

    expect(guardVersionMirrors(root).violations).toEqual([]);
  });

  test('rejects a CI literal that disagrees with the pin', () => {
    const root = makeTree({
      'config/toolchain.json': pins('1.4.2'),
      '.bun-version': '1.4.2\n',
      '.github/workflows/ci.yml': workflow('1.4.0'),
    });

    const violations = guardVersionMirrors(root).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('.github/workflows/ci.yml');
    expect(violations[0].message).toContain('1.4.0');
  });

  test('reports a workflow that pins no Bun version at all', () => {
    // Silence is not agreement. A workflow with no BUN_VERSION installs whatever
    // the runner defaults to, which is exactly the floating toolchain the pin
    // exists to prevent.
    const root = makeTree({
      'config/toolchain.json': pins('1.4.2'),
      '.bun-version': '1.4.2\n',
      '.github/workflows/ci.yml': workflow(null),
    });

    expect(guardVersionMirrors(root).violations).toHaveLength(1);
  });

  test('the live repository agrees with itself', () => {
    // The fixture cases prove the rule; this proves the rule is currently met.
    expect(guardVersionMirrors(REPO_ROOT).violations).toEqual([]);
  });
});

describe('documented-paths', () => {
  // The scripts restructure moved `scripts/src/lib/**` and nine documents kept
  // pointing at the old layout. Nothing failed: a reader following the link
  // concluded the rule it described was not enforced, which is the opposite of
  // the truth and the more expensive mistake, because it gets acted on.
  test('accepts a document pointing at an existing path', () => {
    const root = makeTree({
      'docs/logs.md': 'The adapter lives in `scripts/src/logs/filter.ts`.\n',
      'scripts/src/logs/filter.ts': 'export const f = 1;\n',
    });

    expect(guardDocumentedPaths(root).violations).toEqual([]);
  });

  test('reports the stale path, with the file and line', () => {
    const root = makeTree({
      'docs/logs.md': 'See `scripts/src/logs/gone.ts` for the adapter.\n',
    });

    const violations = guardDocumentedPaths(root).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('docs/logs.md');
    expect(violations[0].message).toContain('scripts/src/logs/gone.ts');
  });

  test('accepts a path narrated as removed, so history is not falsified', () => {
    // "This repository once had X" is a true statement about a file that is gone.
    // Reporting it would train the reader to ignore the guard.
    const root = makeTree({
      'docs/agent.md': 'This repository once had `.pi/extensions/logs.test.ts`.\n',
    });

    expect(guardDocumentedPaths(root).violations).toEqual([]);
  });

  test('reads the paragraph, not the line, because prose wraps', () => {
    // The verb sits on the previous line from the path it governs, which is how
    // a wrapped Markdown paragraph reads.
    const root = makeTree({
      'docs/logs.md': 'The previous application was removed from\n`apps/frontend/hub`.\n',
    });

    expect(guardDocumentedPaths(root).violations).toEqual([]);
  });

  test('reports the same wrapped path without historical narration', () => {
    const root = makeTree({
      'docs/logs.md': 'The application lives\nat `apps/frontend/hub`.\n',
    });
    expect(guardDocumentedPaths(root).violations).toHaveLength(1);
  });

  test('exempts the incident write-ups entirely', () => {
    // These record paths that were correct when written. Rewriting them would
    // erase the evidence for the .gitignore bug that hid eight source files.
    const root = makeTree({
      'docs/first-round-review.md': 'Fixed: `scripts/src/lib/tools.ts` resolves the pinned copy.\n',
      'docs/starter-extraction.md': 'Silently excluded `scripts/src/lib/logs/`.\n',
    });

    expect(guardDocumentedPaths(root).violations).toEqual([]);
  });

  test('ignores globs and placeholders, which are not paths', () => {
    const root = makeTree({
      'docs/architecture.md': 'Layers live under `packages/shared/**` and `apps/<app>/src`.\n',
    });

    expect(guardDocumentedPaths(root).violations).toEqual([]);
  });

  test('the live documentation agrees with the live tree', () => {
    // A missing document must fail before the guard's absent-file handling.
    for (const doc of [
      'AGENTS.md',
      'README.md',
      'docs/logs.md',
      'docs/cloudflare.md',
      'docs/secrets.md',
      'docs/rename-checklist.md',
      'docs/README.md',
      'docs/adding-a-feature.md',
      'docs/agent.md',
      'docs/architecture.md',
      'docs/capability-matrix.md',
      'docs/first-round-review.md',
      'docs/lint.md',
      'docs/starter-extraction.md',
      'docs/testing.md',
      'docs/toolchain.md',
    ]) {
      expect(existsSync(join(REPO_ROOT, doc)), `Expected document is missing: ${doc}`).toBe(true);
    }
    expect(guardDocumentedPaths(REPO_ROOT).violations).toEqual([]);
  });
});

describe('workspace-boundary: import scanning', () => {
  // Both of these were found by probing the scanner rather than reading it, and both
  // failed the same way: text that was not an import was treated as one, or an
  // import was invisible. Either way the guard's report stopped matching the code.

  test('ignores an import inside a block comment', () => {
    // Block comments were not stripped at all, so a commented-out import read as a
    // live one. `importComment` only covered `//`, which is why this survived: the
    // suite had a comment case and it passed.
    const root = makeTree({
      'apps/backend/api/src/lib/db.ts': `/* import { thing } from '${pkg('ui')}'; */\nexport const x = 1;\n`,
    });

    expect(guardWorkspaceBoundary(root).violations).toEqual([]);
  });

  test('sees an import inside a block comment that also contains real code', () => {
    const root = makeTree({
      'apps/backend/api/src/lib/db.ts': `/*\n * notes:\n */\nimport { thing } from '${pkg('ui')}';\n`,
    });

    const violations = guardWorkspaceBoundary(root).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(4);
  });

  test('does not treat import text inside a string as an import', () => {
    // The scanner never looked inside strings, so this is the inverse failure: a real
    // violation quoted in a string would be invisible, and the guard would report a
    // clean tree.
    const root = makeTree({
      'apps/backend/api/src/lib/db.ts':
        `export const docs =\n  "run: import { thing } from '${pkg('ui')}'";\n` +
        `import { thing } from '${pkg('ui')}';\n`,
    });

    const violations = guardWorkspaceBoundary(root).violations;
    // Exactly one: the real import on line 3, not the quoted one on line 2.
    expect(violations).toHaveLength(1);
    expect(violations[0].line).toBe(3);
  });

  test.each(['"/*"', "'// comment'", '`/* template`'])(
    'sees a forbidden import after a literal containing a comment marker: %s',
    (literal) => {
      const root = makeTree({
        'apps/backend/api/src/lib/db.ts': `const value = ${literal};\nimport { thing } from '${pkg('ui')}';\n`,
      });
      const violations = guardWorkspaceBoundary(root).violations;
      expect(violations).toHaveLength(1);
      expect(violations[0].line).toBe(2);
    },
  );

  test('sees a static specifier embedded in a template literal', () => {
    // The interpolation is code, so blanking the whole template would hide a real
    // import. The static prefix is what makes this resolvable.
    const root = makeTree({
      'apps/backend/api/src/lib/db.ts': `export const load = () => import(\`${pkg('ui')}/thing\`);\n`,
    });

    expect(guardWorkspaceBoundary(root).violations).toHaveLength(1);
  });

  test('a fully interpolated specifier is not reported, and that is stated not assumed', () => {
    // `import(\`../${name}\`)` cannot be resolved statically — the specifier depends on
    // a runtime value. A static scanner cannot know whether it crosses a boundary, so
    // it does not claim to. Asserted so the limitation is a recorded fact rather than
    // a gap someone rediscovers: the honest options are a static import or a lint rule
    // that resolves the constant, not a scanner that guesses.
    //
    // The `${…}` belongs to the *generated* code under test, not to this file, so it is
    // assembled from parts: written literally in a plain string, Biome correctly reads
    // it as a stray template placeholder. No suppression is used, because this
    // repository has none and the fix is to build the string rather than silence the
    // rule.
    const INTERPOLATION = '$' + '{name}';
    const fixture = `export const load = (name: string) => import(\`../../${INTERPOLATION}/thing\`);\n`;

    const root = makeTree({ 'apps/backend/api/src/lib/db.ts': fixture });

    expect(guardWorkspaceBoundary(root).violations).toEqual([]);
  });

  test('catches a CommonJS require across the boundary', () => {
    // `require()` is not matched by the import pattern, so it walked straight through.
    // Nothing in this repository uses it, but a boundary that can be crossed
    // quietly is not a boundary.
    const root = makeTree({
      'apps/backend/api/src/lib/db.ts': `const ui = require('${pkg('ui')}');\n`,
    });

    const violations = guardWorkspaceBoundary(root).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain(pkg('ui'));
  });

  test('still catches every static import form', () => {
    // The hardening must not have narrowed what the pattern matched. Each of these
    // was verified against the previous implementation.
    const forms = [
      `import { a } from '${pkg('ui')}';`,
      `import a from '${pkg('ui')}';`,
      `import * as a from '${pkg('ui')}';`,
      `import type { a } from '${pkg('ui')}';`,
      `import { type a } from '${pkg('ui')}';`,
      `import '${pkg('ui')}';`,
      `export { a } from '${pkg('ui')}';`,
      `export * from '${pkg('ui')}';`,
      `const a = await import('${pkg('ui')}');`,
      `await import(\n  '${pkg('ui')}'\n);`,
    ];

    for (const form of forms) {
      const root = makeTree({ 'apps/backend/api/src/lib/db.ts': `${form}\n` });
      expect(guardWorkspaceBoundary(root).violations, form).toHaveLength(1);
    }
  });

  test('reports the line a violation is on, not the line the comment started', () => {
    // Offsets are preserved by blanking rather than deleting, so a multi-line comment
    // above an import cannot shift the reported line.
    const root = makeTree({
      'apps/backend/api/src/lib/db.ts': `/*\n * a\n * b\n * c\n */\nimport { thing } from '${pkg('ui')}';\n`,
    });

    expect(guardWorkspaceBoundary(root).violations[0]?.line).toBe(6);
  });
});

describe('documented-paths: markdown links', () => {
  // The guard originally checked backticked paths only, and its own documentation
  // index is made of markdown links. A negative control — injecting
  // `[nope](nope.md)` into a document — passed, which is how this was found: by
  // asking whether the guard could fail, not by reading it.
  //
  // A rotten link is worse than a rotten backtick, too. The backtick is a wall of
  // text a reader must parse; the link looks like a working reference until clicked.

  const withDoc = (contents: string): string =>
    makeTree({ 'docs/logs.md': contents, 'docs/cloudflare.md': 'exists\n' });

  test('rejects a link to a file that does not exist', () => {
    const root = withDoc('See [cloudflare](cloudflare-gone.md) for the adapter.\n');

    const violations = guardDocumentedPaths(root).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0].file).toBe('docs/logs.md');
    expect(violations[0].message).toContain('cloudflare-gone.md');
  });

  test('accepts a repo-root-relative link, as the index uses', () => {
    // `[docs/logs.md](docs/logs.md)` from the top level is the shape AGENTS.md and
    // README.md use. Resolved relative to its own document it would be
    // `docs/docs/logs.md`, so this is the case that made a doc-relative-only check
    // look correct.
    const root = makeTree({
      'AGENTS.md': 'See [docs/logs.md](docs/logs.md) for the log CLI.\n',
      'docs/logs.md': 'real\n',
    });

    expect(guardDocumentedPaths(root).violations).toEqual([]);
  });

  test('rejects a root-relative link whose target is gone', () => {
    const root = makeTree({
      'AGENTS.md': 'See [docs/logs.md](docs/logs-OLD.md) for the log CLI.\n',
      'docs/logs.md': 'real\n',
    });

    const violations = guardDocumentedPaths(root).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('docs/logs-OLD.md');
  });

  test('a link that omits the extension is a broken link, and is reported', () => {
    // A renderer resolves `[x](docs/testing)` literally, so it is broken even though
    // `docs/testing.md` exists. A `.md` fallback was tried and removed: it made this
    // negative control pass, and no real link here omits its extension.
    const root = makeTree({
      'AGENTS.md': 'See [docs/testing](docs/testing) for the four lanes.\n',
      'docs/testing.md': 'real\n',
    });

    const violations = guardDocumentedPaths(root).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('docs/testing');
  });

  test('resolves a link relative to the document it appears in', () => {
    // `docs/logs.md` linking to `cloudflare.md` is a sibling reference, not a
    // repo-root one.
    const root = withDoc('See [cloudflare](cloudflare.md) for the endpoint.\n');

    expect(guardDocumentedPaths(root).violations).toEqual([]);
  });

  test('ignores anchors, and http and mailto links', () => {
    const root = withDoc(
      'See [the table](#where-the-events-are), [the API](https://example.com/x) and\n' +
        '[mail](mailto:a@example.com).\n',
    );

    expect(guardDocumentedPaths(root).violations).toEqual([]);
  });

  test('exempts a link narrated as removed, so a document can record the change', () => {
    // A document describing a removal must be able to name what was removed, or it
    // cannot record the incident.
    const root = withDoc('The [adapter](scripts/src/logs/gone.ts) was removed in this phase.\n');

    expect(guardDocumentedPaths(root).violations).toEqual([]);
  });

  test('a link that merely looks historical is still reported', () => {
    // The exemption is for records of removals, not a general escape hatch. My first
    // version reused the backticked path's broader list, which contains "used to be"
    // and "previously" — so the sentence "This used to be true: see [gone](nope.md)"
    // waved a broken link through. That is the loophole this asserts closed: a stale
    // link must not be dismissible with a clause that has nothing to do with it.
    const root = withDoc('This used to be true: see [gone](nope.md).\n');

    const violations = guardDocumentedPaths(root).violations;
    expect(violations).toHaveLength(1);
    expect(violations[0].message).toContain('nope.md');
  });

  test('the same holds for "previously" and "formerly"', () => {
    // Both are in the broader list, and both are things a writer reaches for when
    // describing a change that *is* still documented — not when justifying a link
    // that no longer resolves.
    for (const opener of ['Previously,', 'Formerly,']) {
      const root = withDoc(`${opener} see [gone](nope.md) for the old layout.\n`);
      expect(guardDocumentedPaths(root).violations).toHaveLength(1);
    }
  });

  test('reports the line the link is on', () => {
    const root = withDoc('one\ntwo\nSee [gone](nope.md) here.\n');

    expect(guardDocumentedPaths(root).violations[0]?.line).toBe(3);
  });
});

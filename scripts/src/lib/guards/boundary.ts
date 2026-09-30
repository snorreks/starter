// scripts/src/lib/guards/boundary.ts
//
// Hard-invariant boundary checks.
//
// These are not ratchets and have no baselines. The inherited project carried a
// debt ledger with waivers; the architecture here is new, so there is no debt to
// record and a baseline would only be a place for a failure to hide.
//
// Each rule below is an invariant that is either true or false, and that a
// reasonable person would agree should be true. A check that needs a baseline
// to pass is not a check; it is a report.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export type Violation = {
  rule: string;
  file: string;
  line: number;
  message: string;
};

export type GuardResult = {
  id: string;
  label: string;
  /** Always false: these are invariants, not ratchets. */
  baselineCount: 0;
  violations: Violation[];
};

export const REPO_ROOT = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');

/** Skip these: vendored, generated, or not source. */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  '.moon',
  '.svelte-kit',
  'build',
  'dist',
  '.wrangler',
  'state',
  'coverage',
  'test-results',
  'playwright-report',
  '.direnv',
]);

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.svelte'];

export const listSourceFiles = (root: string): string[] => {
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (IGNORED_DIRS.has(entry)) {
        continue;
      }
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
        found.push(full);
      }
    }
  };

  walk(root);
  return found;
};

const linesOf = (file: string): string[] => readFileSync(file, 'utf8').split('\n');

/** The layer a path belongs to. */
export type Layer = 'shared' | 'backend' | 'frontend' | 'client' | 'api' | 'tool';

export const layerOf = (relativePath: string): Layer | null => {
  if (relativePath.startsWith('packages/shared/')) return 'shared';
  if (relativePath.startsWith('packages/backend/')) return 'backend';
  if (relativePath.startsWith('packages/frontend/')) return 'frontend';
  // The two apps are separate layers. Treating `apps/` as one layer let the API
  // import `@starter/ui` — Svelte component code — into a Worker, where it would
  // compile and then fail at runtime, or drag `svelte/internal` into a bundle
  // that has no DOM.
  if (relativePath.startsWith('apps/frontend/')) return 'client';
  if (relativePath.startsWith('apps/backend/')) return 'api';
  if (relativePath.startsWith('apps/')) return null;
  if (relativePath.startsWith('scripts/') || relativePath.startsWith('.pi/')) return 'tool';
  return null;
};

/**
 * What a layer may import from.
 *
 * `shared` may depend on its own siblings, not on nothing: `logger` needs the
 * event types from `schemas`, and `utils` needs the logger. What shared must
 * never do is reach sideways into a plane, because that is what would drag
 * `drizzle-orm` or `svelte` into a browser or Worker bundle.
 */
const ALLOWED_IMPORTS: Record<string, readonly string[]> = {
  shared: ['@starter/schemas', '@starter/logger', '@starter/utils'],
  // Backend may use shared. Never frontend, never another app.
  backend: ['@starter/schemas', '@starter/logger', '@starter/utils', '@starter/database', '@starter/auth'],
  // Frontend may use shared. Never backend.
  frontend: ['@starter/schemas', '@starter/logger', '@starter/utils', '@starter/ui', '@starter/frontend-services'],
  // The client app: frontend and shared. Never the database or auth packages —
  // `better-auth` and `drizzle-orm` are server libraries.
  client: [
    '@starter/schemas',
    '@starter/logger',
    '@starter/utils',
    '@starter/ui',
    '@starter/frontend-services',
  ],
  // The API app: backend and shared. Never the UI, which is Svelte.
  api: [
    '@starter/schemas',
    '@starter/logger',
    '@starter/utils',
    '@starter/database',
    '@starter/auth',
  ],
  // Tooling: the CLI and agent extensions run outside both planes.
  tool: ['@starter/schemas', '@starter/logger', '@starter/utils'],
};

const IMPORT_PATTERN = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

const importsIn = (lines: readonly string[]): { specifier: string; line: number }[] => {
  const found: { specifier: string; line: number }[] = [];

  lines.forEach((text, index) => {
    // Only real code, not a mention inside a comment.
    const code = text.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    for (const match of code.matchAll(IMPORT_PATTERN)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        found.push({ specifier, line: index + 1 });
      }
    }
  });

  return found;
};

/**
 * Rule 1 — workspace boundaries.
 *
 * A layer may only import from the layers it is declared to depend on. This is
 * the check that stops a database module from reaching a browser bundle, and it
 * is why the shared packages are genuinely portable.
 */
export const guardWorkspaceBoundary = (root = REPO_ROOT): GuardResult => {
  const violations: Violation[] = [];

  for (const file of listSourceFiles(root)) {
    const relativePath = relative(root, file);
    const layer = layerOf(relativePath);
    if (layer === null) {
      continue;
    }

    const allowed = ALLOWED_IMPORTS[layer] ?? [];
    for (const { specifier, line } of importsIn(linesOf(file))) {
      if (!specifier.startsWith('@starter/')) {
        continue;
      }
      // Subpath imports (`@starter/schemas/notes`) count as the package.
      const packageName = `@starter/${specifier.split('/')[1] ?? ''}`;

      if (!allowed.includes(packageName)) {
        violations.push({
          rule: 'workspace-boundary',
          file: relativePath,
          line,
          message:
            `The "${layer}" layer may not import "${packageName}".\n` +
            `  Allowed here: ${allowed.join(', ') || '(nothing)'}.\n` +
            `  Move shared, pure logic down to packages/shared instead.`,
        });
      }
    }
  }

  return {
    id: 'workspace-boundary',
    label: 'Workspace boundaries',
    baselineCount: 0,
    violations,
  };
};

// ── Rule 2 — no server-side mutable request state ────────────────────────────

/**
 * Rule 2 — request state must not live in module scope.
 *
 * A `let env` or `let currentUser` at module scope in the API is a cross-request
 * data leak waiting for a second concurrent request. The pattern this forbids
 * is narrow on purpose (`setEnvForRequest`-style helpers and module-level
 * mutable singletons), so it does not fire on ordinary code.
 */
const REQUEST_STATE_PATTERNS: readonly { pattern: RegExp; message: string }[] = [
  {
    pattern: /^\s*(?:export\s+)?let\s+\w*(?:env|request|user|currentUser|session|binding)\w*\s*[;:]/i,
    message:
      'Module-level mutable request state. A Worker isolate handles many concurrent ' +
      'requests; the last writer wins for all of them.',
  },
  {
    // Matches the declaration, not the call shape, so it catches both
    // `export function setEnvForRequest(...)` and
    // `export const setEnvForRequest = (...) =>`. A pattern that required `(` to
    // follow the name missed the arrow-function form entirely.
    pattern:
      /^\s*export\s+(?:const|function|let)\s+(?:set|install)\w*(?:Env|Request|User|Session)\w*/i,
    message:
      'A setter that stashes request state on a module. Pass it as an argument ' +
      'instead, or build it inside the handler.',
  },
];

export const guardRequestState = (root = REPO_ROOT): GuardResult => {
  const violations: Violation[] = [];
  const apiDir = join(root, 'apps/backend/api/src');

  for (const file of listSourceFiles(apiDir)) {
    const relativePath = relative(root, file);
    linesOf(file).forEach((text, index) => {
      const code = text.replace(/\/\/.*$/, '');
      for (const { pattern, message } of REQUEST_STATE_PATTERNS) {
        if (pattern.test(code)) {
          violations.push({
            rule: 'request-state',
            file: relativePath,
            line: index + 1,
            message,
          });
        }
      }
    });
  }

  return { id: 'request-state', label: 'No module-level request state', baselineCount: 0, violations };
};

// ── Rule 3 — no debug leftovers ──────────────────────────────────────────────

export const guardNoLeftovers = (root = REPO_ROOT): GuardResult => {
  const violations: Violation[] = [];

  const LEFTOVERS: readonly { pattern: RegExp; message: string }[] = [
    { pattern: /\bconsole\.log\(/, message: 'console.log in production source. Use the logger.' },
    // Anchored to a whole statement. An unanchored /\bdebugger\b/ also matches
    // this file's own pattern literal, which is how a guard ends up failing on
    // the source of the guard.
    { pattern: /^\s*(?:await\s+)?debugger\s*;?\s*$/, message: 'A `debugger` statement is committed.' },
    { pattern: /\bTODO\(remove\)|\bFIXME\(remove\)/, message: 'A removal marker that was never removed.' },
  ];

  for (const file of listSourceFiles(root)) {
    const relativePath = relative(root, file);
    // Tests may print, and the guards' own source necessarily contains the
    // patterns being searched for.
    if (/\.(test|spec)\.tsx?$/.test(relativePath) || relativePath.startsWith('scripts/src/lib/guards/')) {
      continue;
    }
    linesOf(file).forEach((text, index) => {
      const code = text.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
      for (const { pattern, message } of LEFTOVERS) {
        if (pattern.test(code)) {
          violations.push({ rule: 'no-leftovers', file: relativePath, line: index + 1, message });
        }
      }
    });
  }

  return { id: 'no-leftovers', label: 'No debug leftovers', baselineCount: 0, violations };
};

// ── Rule 4 — no source file is gitignored ────────────────────────────────────

/**
 * Rule 4 — nothing under `src/` may be excluded from version control.
 *
 * This exists because the failure is invisible. `.gitignore`'s `logs/` pattern
 * was meant for a log output directory, but git applies an unanchored pattern at
 * every depth, so it also matched `scripts/src/lib/logs/` — eight files,
 * including the whole log CLI and its 31 tests, that passed locally and were
 * never committed. Nothing warned about it: `git status` was clean, the suite
 * was green, and the feature was simply absent from the repository.
 *
 * An ignored file cannot be reviewed, cannot be reverted, and does not travel
 * to anyone who clones the template. That makes it worse than a known bug.
 *
 * The check is a filesystem walk, not `git check-ignore`, so it does not need a
 * git repository and works on a fresh copy before `git init`.
 */
export const guardSourceIsTracked = (root = REPO_ROOT): GuardResult => {
  const violations: Violation[] = [];
  const ignoreRules = readIgnoreRules(root);
  if (ignoreRules.length === 0) {
    return {
      id: 'source-is-tracked',
      label: 'No source is gitignored',
      baselineCount: 0,
      violations,
    };
  }

  const seen = new Set<string>();

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (IGNORED_DIRS.has(entry) || entry === '.git') {
        continue;
      }
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
        continue;
      }

      const relativePath = relative(root, full);
      // Already reported as part of a directory-level match.
      if (seen.has(relativePath)) {
        continue;
      }

      const matched = firstMatchingRule(relativePath, ignoreRules);
      if (matched !== null) {
        seen.add(relativePath);
        violations.push({
          rule: 'source-is-tracked',
          file: relativePath,
          line: matched.line,
          message:
            `.gitignore line ${matched.line} (${matched.raw}) excludes this source file.\n` +
            `  It is not in the repository, so it cannot be reviewed, reverted, or cloned.\n` +
            `  Anchor the pattern to the output directory it was meant for, or drop it.`,
        });
      }
    }
  };

  for (const extra of ['scripts/src', 'apps', 'packages']) {
    const directory = join(root, extra);
    // Not every tree has all three, and a missing one is not a violation.
    if (existsSync(directory)) {
      walk(directory);
    }
  }

  return {
    id: 'source-is-tracked',
    label: 'No source is gitignored',
    baselineCount: 0,
    violations,
  };
};

type IgnoreRule = { raw: string; regex: RegExp; negated: boolean; line: number };

/** Parse `.gitignore` into matchable rules, skipping blanks and comments. */
const readIgnoreRules = (root: string): IgnoreRule[] => {
  const file = join(root, '.gitignore');
  if (!existsSync(file)) {
    return [];
  }

  const rules: IgnoreRule[] = [];
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((raw, index) => {
      const trimmed = raw.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) {
        return;
      }
      const negated = trimmed.startsWith('!');
      const body = negated ? trimmed.slice(1) : trimmed;
      // Directory-only patterns (`build/`) still match the files inside, which
      // is how the walk treats them.
      const anchored = body.startsWith('/');
      const withoutSlash = body.replace(/\/+$/, '').replace(/^\//, '');
      // `*` stops at a separator so `*.log` does not swallow a directory name,
      // and `**` spans directories.
      const source = withoutSlash
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*')
        .replace(/\?/g, '[^/]');

      // Unanchored patterns match at any depth: this is the behaviour that hid
      // the `logs/` bug, and it is what git itself does.
      const prefix = anchored ? '^' : '(?:^|.*/)';
      rules.push({
        raw: trimmed,
        negated,
        line: index + 1,
        regex: new RegExp(`${prefix}${source}(?:/.*)?$`),
      });
    });

  return rules;
};

/** The last matching rule wins, as in git: a later `!` re-includes. */
const firstMatchingRule = (relativePath: string, rules: readonly IgnoreRule[]): IgnoreRule | null => {
  let winner: IgnoreRule | null = null;
  for (const rule of rules) {
    if (rule.regex.test(relativePath)) {
      winner = rule;
    }
  }
  return winner !== null && !winner.negated ? winner : null;
};

/**
 * The guard set, each paired with the id it reports under.
 *
 * Pairing them here means `--only` filters on the same string the report prints,
 * so the two cannot drift.
 */
export const ALL_GUARDS = [
  { id: 'workspace-boundary', run: guardWorkspaceBoundary },
  { id: 'request-state', run: guardRequestState },
  { id: 'no-leftovers', run: guardNoLeftovers },
  { id: 'source-is-tracked', run: guardSourceIsTracked },
] as const;

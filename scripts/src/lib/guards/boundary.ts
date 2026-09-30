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

import { readFileSync, readdirSync, statSync } from 'node:fs';
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
export const layerOf = (relativePath: string): 'shared' | 'backend' | 'frontend' | 'app' | 'tool' | null => {
  if (relativePath.startsWith('packages/shared/')) return 'shared';
  if (relativePath.startsWith('packages/backend/')) return 'backend';
  if (relativePath.startsWith('packages/frontend/')) return 'frontend';
  if (relativePath.startsWith('apps/')) return 'app';
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
  // Apps: client may use frontend, api may use backend. Both may use shared.
  app: [
    '@starter/schemas',
    '@starter/logger',
    '@starter/utils',
    '@starter/ui',
    '@starter/frontend-services',
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
    pattern: /^\s*export\s+(?:const|function)\s+set\w*(?:Env|Request|User|Session)\w*(?:ForRequest)?\s*\(/,
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
] as const;

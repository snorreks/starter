// scripts/src/guards/boundary.ts
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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

export interface Violation {
  rule: string;
  file: string;
  line: number;
  message: string;
}

export interface GuardResult {
  id: string;
  label: string;
  /** Always false: these are invariants, not ratchets. */
  baselineCount: 0;
  violations: Violation[];
}

import { checkMirrors } from '../setup/pins.ts';
// Shared with every other module, so there is one answer to "where is the repo".
// See scripts/src/shared/paths.ts for why this is not recomputed here.
import { REPO_ROOT } from '../shared/paths.ts';

export { REPO_ROOT };

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

/**
 * Every source file beneath `root`, or `[]` when there is no such directory.
 *
 * The absent case is not hypothetical. `guardRequestState` scans one specific
 * directory, and the fixtures that prove it works build throwaway trees that do
 * not contain it. Throwing `ENOENT` from a walk meant those tests failed on a
 * missing directory rather than on the rule they exist to check, and a guard that
 * crashes reports nothing at all — the one outcome worse than a false violation.
 */
export const listSourceFiles = (root: string): string[] => {
  const found: string[] = [];

  const walk = (directory: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries) {
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

const textOf = (file: string): string => readFileSync(file, 'utf8');
const linesOf = (file: string): string[] => readFileSync(file, 'utf8').split('\n');

/**
 * The layer a path belongs to.
 *
 * `client` and `api` are separate layers even though both live under `apps/`.
 * Merged into one layer, the API was permitted to import `@starter/ui` — Svelte
 * into a Worker — and the client `@starter/database`.
 */
export type Layer = 'shared' | 'backend' | 'frontend' | 'client' | 'client-server' | 'tool';

export const layerOf = (relativePath: string): Layer | null => {
  if (relativePath.startsWith('packages/shared/')) {
    return 'shared';
  }
  if (relativePath.startsWith('packages/backend/')) {
    return 'backend';
  }
  if (relativePath.startsWith('packages/frontend/')) {
    return 'frontend';
  }
  if (isClientServerModule(relativePath)) {
    return 'client-server';
  }
  // Everything else in the SvelteKit app is browser code. Treating `apps/` as one
  // layer let a server module and a component share a permission set, which is
  // exactly the distinction this migration has to keep: `apps/frontend/**` is one
  // directory holding two runtimes, and the boundary between them is the
  // `client-server` check above, not the directory.
  if (relativePath.startsWith('apps/frontend/')) {
    return 'client';
  }
  if (relativePath.startsWith('apps/')) {
    return null;
  }
  if (relativePath.startsWith('scripts/') || relativePath.startsWith('.pi/')) {
    return 'tool';
  }
  return null;
};

/**
 * Server-only modules inside the SvelteKit application.
 *
 * This is the narrow policy adjustment that lets one application hold both a
 * browser half and a Worker half. It is deliberately a *list of two concrete
 * shapes* rather than "everything under `src/lib/server`", because a broad rule
 * is indistinguishable from the sweeping exemption it replaces: a new directory
 * named `server` would silently become server-only, and a file under the existing
 * `src/lib/server/` would be trusted by its location rather than by what it
 * imports.
 *
 * Two shapes, both from the framework rather than from a convention:
 *
 *   1. Everything beneath `src/lib/server/` — the application's own server-only
 *      area. SvelteKit treats a leading `server` path segment the same way.
 *   2. The route adapters the framework only ever compiles into the Worker:
 *      `+server.ts`, `+page.server.ts` and `+layout.server.ts` anywhere under
 *      `src/routes/`, plus `src/hooks.server.ts`.
 *
 * What this does *not* cover, and why that matters: a `+page.svelte` is not in
 * this list, so the components and the client services in the same directory keep
 * the browser-only permission set. A single app holding two runtimes is only
 * safe while the two are distinguishable by something a reviewer can see in the
 * path. PR C replaces this mechanism with a resolved-dependency check; until then
 * this is the narrowest rule that admits the legitimate imports, and the
 * acceptance it buys is proven by `check:bundle` on the built artifact, which
 * fails if any of these imports reaches a client chunk.
 */
const isClientServerModule = (relativePath: string): boolean => {
  const app = 'apps/frontend/client/';
  if (!relativePath.startsWith(app)) {
    return false;
  }

  const within = relativePath.slice(app.length);

  if (within.startsWith('src/lib/server/')) {
    return true;
  }

  if (within === 'src/hooks.server.ts') {
    return true;
  }

  return /(^|\/)\+(?:server|page\.server|layout\.server)\.ts$/.test(within);
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
  backend: [
    '@starter/schemas',
    '@starter/logger',
    '@starter/utils',
    '@starter/database',
    '@starter/auth',
  ],
  // Frontend may use shared. Never backend.
  frontend: [
    '@starter/schemas',
    '@starter/logger',
    '@starter/utils',
    '@starter/ui',
    '@starter/frontend-services',
  ],
  // The client app: frontend and shared. Never the database or auth packages —
  // `better-auth` and `drizzle-orm` are server libraries.
  client: [
    '@starter/schemas',
    '@starter/logger',
    '@starter/utils',
    '@starter/ui',
    '@starter/frontend-services',
  ],
  // Server-only modules inside the client app. Backend and shared, plus the same
  // set `client` has: a route adapter legitimately imports a DTO type from
  // `@starter/schemas`, and a page's own ViewModel, because a `+page.svelte` and
  // its `+page.server.ts` are different halves of one screen.
  //
  // What it must never gain: `@starter/ui` or `@starter/frontend-services`, which
  // are browser code. Svelte components in a Worker compile and then fail, and
  // `svelte/internal` in a bundle with no DOM is the same problem one layer down.
  'client-server': [
    '@starter/schemas',
    '@starter/logger',
    '@starter/utils',
    '@starter/database',
    '@starter/auth',
  ],
  // Tooling: the CLI and agent extensions run outside both planes.
  tool: ['@starter/schemas', '@starter/logger', '@starter/utils'],
};

/**
 * Static specifiers, from one pattern.
 *
 * Covers every form TypeScript and Svelte use: named, default, namespace,
 * type-only, inline `type`, side-effect, `export … from`, and dynamic `import()`
 * with a literal argument — including one spread across lines, because `\s*`
 * matches newlines.
 *
 * The backtick is in the delimiter set because `` import(`…`) `` is legal and common.
 * The previous `[^'"]+` could not match a template-literal specifier at all, so a
 * static import written that way was invisible — and `codeOnly` goes to real trouble
 * to preserve it.
 */
const IMPORT_PATTERN = /(?:from|import)\s*\(?\s*['"`]([^'"`]+)['"`]/g;

/**
 * `require()`, which the pattern above does not match.
 *
 * Nothing in this repository uses it — Bun and the Workers runtime both resolve ESM
 * — but a CommonJS call reaching across a boundary would otherwise walk straight
 * through this guard, and the whole point of the rule is that the boundary cannot be
 * crossed quietly.
 */
const REQUIRE_PATTERN = /\brequire\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g;

/**
 * Code only: comments blanked, ordinary strings blanked, import specifiers kept.
 *
 * The ordering is the whole difficulty, and getting it wrong fails in opposite
 * directions:
 *
 *  - Blank comments and strings *first*, and the specifier quotes go with them —
 *    `import { a } from '@x'` becomes `import { a } from    ` and every import in
 *    the repository disappears. That failure is silent: the guard reports a clean
 *    tree because it sees nothing.
 *  - Scan quotes *first*, and a commented-out import is read as a live one.
 *
 * So one pass handles all three, left to right: comments blank, specifier quotes
 * kept, other quotes blanked.
 */
const codeOnly = (text: string): string => {
  const KEYWORDS = ['from', 'import', 'require'];
  const isSpecifierStart = (before: string): boolean =>
    KEYWORDS.some((keyword) => new RegExp(`${keyword}\\s*\\(?\\s*$`).test(before));

  let out = '';
  let index = 0;

  while (index < text.length) {
    const rest = text.slice(index);

    // Only markers before the next quote start comments. Literal contents are
    // handled by the quote scanner below.
    const quote = rest.search(/['"`]/);
    const lineComment = rest.startsWith('//') ? 0 : rest.indexOf('//');
    const blockComment = rest.startsWith('/*') ? 0 : rest.indexOf('/*');
    const commentAt = [lineComment, blockComment]
      .filter((at) => at !== -1)
      .sort((a, b) => a - b)[0];

    if (commentAt !== undefined && (quote === -1 || commentAt < quote)) {
      out += rest.slice(0, commentAt);
      const isBlock = rest.startsWith('/*', commentAt);
      const end = isBlock ? rest.indexOf('*/', commentAt + 2) : rest.indexOf('\n', commentAt);
      if (end === -1) {
        out += rest.slice(commentAt).replace(/[^\n]/g, ' ');
        break;
      }
      // The newline itself is kept so line numbering downstream is unaffected.
      out += rest.slice(commentAt, end).replace(/[^\n]/g, ' ') + (isBlock ? '  ' : '');
      index += isBlock ? end + 2 : end;
      continue;
    }

    if (quote === -1) {
      out += rest;
      break;
    }

    // Append the text before the quote first, so the lookbehind below sees it.
    // Reading `out` before appending looks equivalent and is not: on the first
    // iteration `out` is empty, every quote looks like an ordinary string, and the
    // whole file reports zero imports.
    out += rest.slice(0, quote);

    if (!isSpecifierStart(out.slice(-12))) {
      // An ordinary string. Blank it and carry on past it rather than stopping:
      // a line can hold a string *and* a real import, and `break` here would hide
      // the import that follows. This was the third version of this loop to get it
      // wrong in a different direction, which is why each step has a test.
      const opener = rest[quote];
      const closer = CLOSER_FOR[opener] ?? opener;
      let cursor = quote + 1;
      let blanked = '';

      while (cursor < rest.length) {
        if (rest[cursor] === '\\') {
          blanked += '  ';
          cursor += 2;
          continue;
        }
        if (rest[cursor] === closer) {
          blanked += closer;
          cursor += 1;
          break;
        }

        // A template's `${…}` is code, not text. Blanking it would hide a real
        // dynamic import — `` import(`./${name}.ts`) `` — behind the literal chunks
        // around it, so the interpolation is kept and scanned normally.
        if (opener === '`' && rest[cursor] === '$' && rest[cursor + 1] === '{') {
          let depth = 1;
          let scan = cursor + 2;
          while (scan < rest.length && depth > 0) {
            if (rest[scan] === '{') {
              depth += 1;
            }
            if (rest[scan] === '}') {
              depth -= 1;
            }
            scan += 1;
          }
          // The interpolation is code, so it is kept and scanned. Written as a template so the
          // literal `${` and `}` around it are visible as such; a nested `${${…}}`
          // reads as noise and Biome reports the interpolated variable as unused.
          blanked += `\${${codeOnly(rest.slice(cursor + 2, scan - 1))}}`;
          cursor = scan;
          continue;
        }

        blanked += ' ';
        cursor += 1;
      }

      out += blanked;
      index += cursor;
      continue;
    }

    // Keep the quotes so the pattern can read the specifier, then continue after it.
    const opener = rest[quote];
    const closer = CLOSER_FOR[opener] ?? opener;
    const end = rest.indexOf(closer, quote + 1);
    if (end === -1) {
      out += rest.slice(quote);
      break;
    }
    out += rest.slice(quote, end + 1);
    index += end + 1;
  }

  return out;
};

/**
 * Every static import in a file, with the line each one starts on.
 *
 * The whole file is scanned rather than line by line, because an import can span
 * lines:
 *
 *     await import(
 *       '@starter/ui'
 *     );
 *
 * A per-line scanner sees the specifier without the `import(` that introduces it, so
 * it misses exactly the case a boundary guard must not miss. Line numbers are
 * recovered from the match offset against the original text, not from the blanked
 * copy, so a multi-line block comment above an import cannot shift what is reported.
 */
/** The quote that closes a given opener. Identity for all three, but named so the lookup
 * below is not a nested ternary. */
const SINGLE = "'";
const DOUBLE = '"';
const BACKTICK = '`';
const CLOSER_FOR: Record<string, string> = {
  [SINGLE]: SINGLE,
  [DOUBLE]: DOUBLE,
  [BACKTICK]: BACKTICK,
};

const importsIn = (text: string): { specifier: string; line: number }[] => {
  const found: { specifier: string; line: number }[] = [];

  // Blanked copy is the same length as the original, so an offset means the same line
  // in both. That is what makes reporting a line number from the blanked scan safe.
  const code = codeOnly(text);

  for (const pattern of [IMPORT_PATTERN, REQUIRE_PATTERN]) {
    for (const match of code.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) {
        found.push({ specifier, line: text.slice(0, match.index).split('\n').length });
      }
    }
  }

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
    for (const { specifier, line } of importsIn(textOf(file))) {
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
    pattern:
      /^\s*(?:export\s+)?let\s+\w*(?:env|request|user|currentUser|session|binding)\w*\s*[;:]/i,
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

  // The whole SvelteKit `src` tree, not only a server-only subdirectory. The rule
  // is about request identity, and a `let currentUser` written into a component or
  // a client service is the same defect: a module-scope value read by the next
  // caller. The scanned directory used to be `apps/backend/api/src`; that
  // application no longer exists, and scanning only `src/lib/server` would have
  // quietly reduced this guard's coverage in exchange for a tidier diff.
  const appSrc = join(root, 'apps/frontend/client/src');

  for (const file of listSourceFiles(appSrc)) {
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

  return {
    id: 'request-state',
    label: 'No module-level request state',
    baselineCount: 0,
    violations,
  };
};

// ── Rule 3 — no debug leftovers ──────────────────────────────────────────────

export const guardNoLeftovers = (root = REPO_ROOT): GuardResult => {
  const violations: Violation[] = [];

  const LEFTOVERS: readonly { pattern: RegExp; message: string }[] = [
    { pattern: /\bconsole\.log\(/, message: 'console.log in production source. Use the logger.' },
    // Anchored to a whole statement. An unanchored /\bdebugger\b/ also matches
    // this file's own pattern literal, which is how a guard ends up failing on
    // the source of the guard.
    {
      pattern: /^\s*(?:await\s+)?debugger\s*;?\s*$/,
      message: 'A `debugger` statement is committed.',
    },
    {
      pattern: /\bTODO\(remove\)|\bFIXME\(remove\)/,
      message: 'A removal marker that was never removed.',
    },
  ];

  for (const file of listSourceFiles(root)) {
    const relativePath = relative(root, file);
    // Tests may print, and the guards' own source necessarily contains the
    // patterns being searched for.
    if (
      /\.(test|spec)\.tsx?$/.test(relativePath) ||
      relativePath.startsWith('scripts/src/guards/')
    ) {
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
 * every depth, so it also matched `scripts/src/logs/` — eight files,
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

interface IgnoreRule {
  raw: string;
  regex: RegExp;
  negated: boolean;
  line: number;
}

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
      //
      // `**` becomes a placeholder before the generic `*` replacement runs, or
      // that replacement would consume one star at a time and erase the
      // distinction between `**` (any depth) and `*` (one segment). A space is
      // the placeholder: it cannot occur in a gitignore path, and unlike the
      // NUL escape it is not a control character.
      const source = withoutSlash
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, ' ')
        .replace(/\*/g, '[^/]*')
        .replace(/ /g, '.*')
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
const firstMatchingRule = (
  relativePath: string,
  rules: readonly IgnoreRule[],
): IgnoreRule | null => {
  let winner: IgnoreRule | null = null;
  for (const rule of rules) {
    if (rule.regex.test(relativePath)) {
      winner = rule;
    }
  }
  return winner !== null && !winner.negated ? winner : null;
};

// ── Rule 5 — registry self-consistency ───────────────────────────────────────

/**
 * Rule 5 — the project's own registries must satisfy their own schemas.
 *
 * `APP_LOG_CONFIG` shipped with `workerName: ''` while its schema required
 * `minLength: 1`, so the registry was invalid and every consumer inherited it.
 * Nothing failed: the type was `string`, the value was a string, and the only
 * thing that could have noticed was a schema check that was never run.
 *
 * A registry that does not validate against the schema that describes it is not
 * a type-safe map, it is a comment.
 *
 * The check is textual rather than an import, deliberately: a guard that
 * imported the module it validates could not report a module that fails to load,
 * which is one of the failures worth catching.
 */
export const guardRegistryIsValid = (root = REPO_ROOT): GuardResult => {
  const violations: Violation[] = [];
  const registryFile = join(root, 'scripts/src/registry/app_registry.ts');

  if (!existsSync(registryFile)) {
    return {
      id: 'registry-valid',
      label: 'Registries satisfy their schemas',
      baselineCount: 0,
      violations,
    };
  }

  const source = readFileSync(registryFile, 'utf8');

  // An empty string satisfies `string` but not `minLength: 1`. That is exactly
  // how the invalid value survived review.
  for (const match of source.matchAll(/workerName:\s*(''|"")/g)) {
    violations.push({
      rule: 'registry-valid',
      file: relative(root, registryFile),
      line: source.slice(0, match.index).split('\n').length,
      message:
        'workerName is set to an empty string.\n' +
        '  The schema requires minLength 1, so this value is invalid; use `null`\n' +
        "  for 'not provisioned', which is what DEPLOYMENT_CONFIG does.",
    });
  }

  // A registry that provisioned a resource would point this template at
  // somebody else's account.
  //
  // The keys are matched as a set rather than enumerated, because this repository
  // has one Worker and one D1 database now and the enumeration was `client|api`
  // — a pair that no longer exists. Naming the shape keeps the check working when
  // the resource count changes, which is the only property it needs: *some* id set
  // to a string literal in the committed registry is the defect.
  for (const match of source.matchAll(
    /d1DatabaseIds:\s*\{\s*\w+:\s*'(?!')|workerNames:\s*\{\s*\w+:\s*'(?!')/g,
  )) {
    violations.push({
      rule: 'registry-valid',
      file: relative(root, registryFile),
      line: source.slice(0, match.index).split('\n').length,
      message:
        'A resource id is set to a literal value.\n' +
        '  DEPLOYMENT_CONFIG must provision nothing; a real id here would make a\n' +
        "  fresh clone target someone else's account. Use `null`.",
    });
  }

  return {
    id: 'registry-valid',
    label: 'Registries satisfy their schemas',
    baselineCount: 0,
    violations,
  };
};

// ── Rule 6 — version mirrors agree with the pins ──────────────────────────────

/**
 * Rule 6 — every generated version mirror matches `config/toolchain.json`.
 *
 * The drift this catches already happened: `.bun-version` said 1.4.0 while CI
 * pinned 1.4.2, and the symptom was `bun install --frozen-lockfile` failing in
 * CI with an error about the lockfile that named nothing useful. Neither file
 * was wrong on its own, and no type system covers two text files.
 *
 * `config/toolchain.json` claims a guard enforces this. Until it did, the claim
 * was false in the one file whose subject is not repeating unverified claims, so
 * the check is here and `checkMirrors` is what it calls.
 *
 * Textual, for the same reason as Rule 5: it must work on a checkout where
 * nothing is installed, and it must be able to report a pin file that is itself
 * unparseable.
 */
export const guardVersionMirrors = (root = REPO_ROOT): GuardResult => {
  const label = 'Version mirrors agree with config/toolchain.json';

  const drifts = checkMirrors(root);

  return {
    id: 'version-mirrors',
    label,
    baselineCount: 0,
    violations: drifts.map((drift) => ({
      rule: 'version-mirrors',
      file: drift.mirror,
      line: 1,
      message: `${drift.mirror} is ${drift.found ?? 'missing'}, expected ${drift.expected}.\n  ${drift.reason}`,
    })),
  };
};

// ── Rule 7 — documented paths exist ──────────────────────────────────────────

/**
 * Rule 7 — every repository path a document points at must exist.
 *
 * The scripts restructure moved `scripts/src/lib/**` into a dispatcher plus
 * domain modules, and nine documents kept pointing at the old layout. Nothing
 * failed. A reader following `docs/architecture.md` to the guard that enforces
 * the request-state rule landed on a path that does not exist, and the natural
 * conclusion is that the rule is not enforced — which is the opposite of the
 * truth, and the more expensive mistake, because it is acted on.
 *
 * Two exclusions, both because the alternative is falsifying a record:
 *
 *   - Documents that narrate the past. "This repository once had
 *     `.pi/extensions/logs.test.ts`" is a true statement about a file that is
 *     gone, and so is "the previous config pointed at `apps/frontend/hub`". The
 *     check reads the surrounding paragraph, not the line, because prose wraps
 *     and the verb is often on the previous line.
 *   - The incident write-ups themselves (`docs/first-round-review.md`,
 *     `docs/starter-extraction.md`), which record paths that were correct when
 *     written. Rewriting those would erase the evidence for the `.gitignore`
 *     bug that hid eight source files from git.
 */
export const guardDocumentedPaths = (root = REPO_ROOT): GuardResult => {
  const violations: Violation[] = [];

  const NARRATED =
    /\b(once had|once was|used to be|previously|former(ly)?|no longer|removed|renamed|moved|pointed at|does not exist|doesn'?t exist|is gone)\b/i;

  /**
   * Removal language only, for markdown links.
   *
   * Narrower than `NARRATED` on purpose. The broader list includes "used to be" and
   * "previously", which are what a writer reaches for when describing a change that
   * *is* still documented — so reusing it here made "This used to be true: see
   * [gone](nope.md)" exempt the broken link in the same line. An exemption that any
   * clause can satisfy is not an exemption, it is a hole.
   *
   * The backticked-path check keeps the broader list because its whole purpose is
   * catching prose like "the scripts restructure moved `scripts/src/lib/**`", where
   * the verb is the point.
   */
  const LINK_NARRATED_REMOVAL =
    /\b(was removed|were removed|has been removed|have been removed|is gone|no longer|renamed to|was moved|were moved|does not exist|doesn'?t exist)\b/i;

  /** A repo-root-relative path in backticks. Narrow on purpose, so prose is not
   * mistaken for a reference. Globs and placeholders are skipped by the caller. */
  const PATH_PATTERN =
    /`((?:scripts|apps|packages|docs|\.pi|\.github|\.moon|config)\/[A-Za-z0-9_./-]+)`/g;

  /**
   * A markdown link, in the two forms these documents actually use.
   *
   * This was the guard's largest hole, found by negative control rather than by
   * reading: it checked backticked paths only, and the documentation index is made
   * of markdown links. A `[x](y)` that rots is a broken link in rendered Markdown —
   * the failure is quieter and more visible than a stale backtick, and nothing
   * noticed. Both shapes occur in these documents and both are checked:
   *
   *   [docs/logs.md](docs/logs.md)   repo-root-relative, from the top level
   *   [logs.md](logs.md)             relative to the containing document
   */
  const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)\)/g;

  /** Anchors and URLs are not filesystem paths. */
  const isNotAPath = (target: string): boolean =>
    target.startsWith('#') ||
    target.startsWith('http://') ||
    target.startsWith('https://') ||
    target.startsWith('mailto:');

  const files: string[] = [
    'README.md',
    'AGENTS.md',
    ...(existsSync(join(root, 'docs')) ? readdirSync(join(root, 'docs')) : [])
      .filter((entry) => entry.endsWith('.md'))
      .map((entry) => join('docs', entry)),
  ];

  for (const relativePath of files) {
    // The incident records are history, not instructions.
    if (relativePath === 'docs/first-round-review.md') {
      continue;
    }
    if (relativePath === 'docs/starter-extraction.md') {
      continue;
    }

    const full = join(root, relativePath);
    if (!existsSync(full)) {
      continue;
    }

    const text = readFileSync(full, 'utf8');
    const docDir = dirname(full);

    /**
     * Where a link target should be looked for.
     *
     * A leading `./` or `../` is unambiguously relative to the document. A bare
     * `docs/…` is *also* valid from the top level, and the documentation index uses
     * that shape, so a target that does not resolve relative to its own document is
     * retried from the repository root before being called missing. Checking both is
     * what lets one rule cover `docs/README.md` and `README.md` without either
     * producing a false positive.
     *
     * Resolved **exactly**, with no `.md` fallback, and that is deliberate. A
     * Markdown renderer resolves a link literally, so `[x](docs/testing)` is a broken
     * link even though `docs/testing.md` exists. The lenient version was tried and
     * removed: it made a negative control pass that should have failed, and no real
     * link in these documents omits its extension.
     */
    const resolves = (target: string): boolean =>
      existsSync(join(docDir, target)) || existsSync(join(root, target));

    for (const match of text.matchAll(LINK_PATTERN)) {
      const target = match[1];
      if (target === undefined || isNotAPath(target) || target.includes('*') || resolves(target)) {
        continue;
      }

      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      const lineEnd = text.indexOf('\n', match.index);
      const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);

      if (LINK_NARRATED_REMOVAL.test(line)) {
        continue;
      }

      violations.push({
        rule: 'documented-paths',
        file: relativePath,
        line: text.slice(0, match.index).split('\n').length,
        message:
          `This document links to ${target}, which does not exist.\n` +
          '  A reader who follows the link concludes the thing it describes is not\n' +
          '  implemented, and a broken link renders as broken. If the target really was\n' +
          '  removed, say so in the same sentence and the guard will leave it alone.',
      });
    }

    for (const match of text.matchAll(PATH_PATTERN)) {
      const path = match[1].replace(/[.,;:]$/, '');
      if (path.includes('*') || path.includes('<') || existsSync(join(root, path))) {
        continue;
      }

      const lineStart = text.lastIndexOf('\n', match.index) + 1;
      const paragraphStart = text.lastIndexOf('\n\n', match.index) + 2;
      const lineEnd = text.indexOf('\n', match.index);
      const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
      const paragraph = text.slice(paragraphStart, lineEnd === -1 ? text.length : lineEnd);

      if (NARRATED.test(line) || NARRATED.test(paragraph)) {
        continue;
      }

      violations.push({
        rule: 'documented-paths',
        file: relativePath,
        line: text.slice(0, match.index).split('\n').length,
        message:
          `This document points at ${path}, which does not exist.\n` +
          '  A reader who follows the link concludes the thing it describes is not\n' +
          '  implemented. To describe something that was removed, say so in the same\n' +
          '  sentence — the guard exempts a path narrated in the past tense.',
      });
    }
  }

  return {
    id: 'documented-paths',
    label: 'Documented paths exist',
    baselineCount: 0,
    violations,
  };
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
  { id: 'registry-valid', run: guardRegistryIsValid },
  { id: 'version-mirrors', run: guardVersionMirrors },
  { id: 'documented-paths', run: guardDocumentedPaths },
] as const;

// scripts/src/ci/cache_scope.ts
//
// Whether Moon's cache may be trusted for this run.
//
// Moon 2.5.5 builds a task's cache key from that task's declared `inputs` plus
// its command and its `env`. Two classes of file that decide the result of every
// task in this workspace are outside that set, and both were measured rather
// than assumed:
//
//   1. Files at the workspace root. A task input may not contain `..`
//      (`parent directory traversal (..) is not supported`), `fileGroups` are
//      project-scope only in 2.5.5, and the workspace `hasher` block offers no
//      additive input. So `bun.lock`, root `package.json`, `bunfig.toml`,
//      `biome.json`, `config/toolchain.json` and `config/tsconfig/**` cannot
//      appear in any key.
//
//   2. A dependency project's sources. `dependsOn` orders the graph; it does not
//      propagate content into a dependent task's key. Measured: a source edit in
//      `packages/shared/logger` re-ran `logger:test` under a new hash while
//      `utils:test` reported the same cached hash as before.
//
// This module fingerprints exactly those files. `resolveCacheMode` then picks
// Moon's own `--cache` mode for the run:
//
//   'read-write'  nothing it cannot see moved; cached hits are sound.
//   'off'         something moved, or the fingerprint could not be read.
//
// It fails closed on purpose. An unreadable fingerprint means `off`, because
// `off` costs time and a wrong `read-write` costs correctness.

import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';

/** Where the last fingerprint is recorded. Gitignored, per checkout. */
export const CACHE_SCOPE_STAMP = join(REPO_ROOT, '.moon', 'cache', 'starter-inputs.sha256');

/**
 * Files outside every Moon project that decide the result of every task.
 *
 * Explicit rather than globbed, because a glob that matches nothing is exactly
 * the defect this exists to prevent: an empty file list hashes to a constant,
 * the constant never changes, and the cache is trusted forever.
 */
export const SHARED_INPUTS = [
  'biome.json',
  'bun.lock',
  'bunfig.toml',
  'package.json',
  '.syncpackrc',
  'config/toolchain.json',
  'config/tsconfig/tsconfig.base.json',
  'config/tsconfig/tsconfig.backend.json',
  'config/tsconfig/tsconfig.frontend.json',
  'config/tsconfig/tsconfig.svelte-kit.json',
] as const;

/** Directories whose sources feed the build of other projects. */
export const PACKAGE_SOURCE_DIRS = [
  'packages/shared/schemas',
  'packages/shared/logger',
  'packages/shared/utils',
  'packages/frontend/ui',
  'packages/frontend/services',
  'packages/backend/database',
  'packages/backend/auth',
] as const;

export interface CacheScope {
  /** Moon's `--cache` value for this run. */
  mode: 'read-write' | 'off';
  /** Hex sha256 over every file in scope. */
  fingerprint: string;
  /** How many files were read. Zero means the fingerprint is not trustworthy. */
  filesRead: number;
  /** Why this mode, for the log line. */
  reason: string;
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Every file in scope, as absolute paths, sorted so the hash is stable. */
export const filesInScope = (root: string = REPO_ROOT): string[] => {
  const shared = SHARED_INPUTS.map((relative) => join(root, relative)).filter(isFile);

  // Each package's sources and manifest. Walked by hand rather than with a glob
  // library so this module stays dependency-free: it is loaded by the command
  // that guards every other command, and a guard that needs a dependency is a
  // guard that can fail before it starts.
  const walk = (dir: string, out: string[]): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, out);
      } else if (entry.isFile()) {
        out.push(path);
      }
    }
  };

  const packages: string[] = [];
  for (const relative of PACKAGE_SOURCE_DIRS) {
    walk(join(root, relative, 'src'), packages);
    const manifest = join(root, relative, 'package.json');
    if (isFile(manifest)) {
      packages.push(manifest);
    }
  }

  return [...shared, ...packages].sort();
};

/** sha256 over the path and content of every file in scope. */
export const fingerprintScope = (
  root: string = REPO_ROOT,
): { fingerprint: string; filesRead: number } => {
  const hash = createHash('sha256');
  let filesRead = 0;

  for (const path of filesInScope(root)) {
    hash.update(path.slice(root.length));
    try {
      hash.update(readFileSync(path));
    } catch {
      // A file that vanished between listing and reading is a changed tree, not
      // a reason to report a hash of half of it.
      hash.update('<unreadable>');
    }
    filesRead += 1;
  }

  return { fingerprint: hash.digest('hex'), filesRead };
};

/**
 * Decide Moon's cache mode for this run, and record the fingerprint.
 *
 * `previous` is read from disk when not supplied, so the test can drive the
 * transition without touching this checkout's stamp.
 */
export const resolveCacheMode = (
  options: { root?: string; previous?: string | null } = {},
): CacheScope => {
  const root = options.root ?? REPO_ROOT;
  const stamp = options.previous === undefined ? readStamp(root) : options.previous;

  let fingerprint = '';
  let filesRead = 0;
  try {
    ({ fingerprint, filesRead } = fingerprintScope(root));
  } catch (error) {
    return {
      mode: 'off',
      fingerprint: '',
      filesRead: 0,
      reason: `the shared-input fingerprint could not be computed (${String(error)}), so nothing is cached`,
    };
  }

  // Zero files is not an empty scope; it is a scope that resolved to nothing, and
  // a hash of nothing never changes. Treat it as unreadable.
  if (filesRead === 0) {
    return {
      mode: 'off',
      fingerprint: '',
      filesRead,
      reason:
        'no shared inputs were found, so a fingerprint would be constant and the cache unsound',
    };
  }

  if (stamp === null) {
    return {
      mode: 'off',
      fingerprint,
      filesRead,
      reason: 'no previous fingerprint, so this run records one and caches nothing',
    };
  }

  if (stamp !== fingerprint) {
    return {
      mode: 'off',
      fingerprint,
      filesRead,
      reason: `${filesRead} files outside every Moon project changed, so no cached result describes this tree`,
    };
  }

  return {
    mode: 'read-write',
    fingerprint,
    filesRead,
    reason: `${filesRead} files outside every Moon project are unchanged, so cached results still describe this tree`,
  };
};

export const readStamp = (root: string = REPO_ROOT): string | null => {
  try {
    return readFileSync(join(root, '.moon', 'cache', 'starter-inputs.sha256'), 'utf8').trim();
  } catch {
    return null;
  }
};

export const writeStamp = (root: string, fingerprint: string): void => {
  mkdirSync(join(root, '.moon', 'cache'), { recursive: true });
  writeFileSync(join(root, '.moon', 'cache', 'starter-inputs.sha256'), `${fingerprint}\n`);
};

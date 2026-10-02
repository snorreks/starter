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
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  // The browser resolver. It decides which Chromium `client:test-browser` and
  // `e2e:e2e` launch, and it lives in `scripts/`, so Moon cannot name it in either
  // project's inputs. Without it here, editing it left both lanes' cached results
  // eligible — the exact failure this module exists to prevent, one file further
  // out. `scripts/moon.yml` also cannot reference it: that is the `..` restriction
  // documented in `.moon/workspace.yml`.
  'scripts/src/shared/browser_path.ts',
] as const;

/** Directories whose sources feed the build of other projects. */
export const PACKAGE_SOURCE_DIRS = [
  'packages/shared/schemas',
  'packages/shared/logger',
  'packages/shared/utils',
  'packages/frontend/ui',
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

/**
 * sha256 over the path and content of every file in scope.
 *
 * Each file is hashed **separately**, and the per-file digests are then hashed
 * into a sorted manifest. Hashing path and content into one running digest is
 * ambiguous: `hash.update(path); hash.update(content)` lets a byte moved across
 * the boundary between one file's content and the next file's path produce the
 * same stream. Per-file digests plus a length-prefixed manifest have no such
 * seam, and the intermediate value is cheap.
 */
export const fingerprintScope = (
  root: string = REPO_ROOT,
): { fingerprint: string; filesRead: number } => {
  const manifest: string[] = [];
  let filesRead = 0;

  for (const path of filesInScope(root)) {
    const relative = path.slice(root.length);
    let digest: string;
    try {
      digest = createHash('sha256').update(readFileSync(path)).digest('hex');
    } catch {
      // A file that vanished between listing and reading is a changed tree, not
      // a reason to report a hash of half of it.
      digest = 'unreadable';
    }
    // The path is length-prefixed so a rename that moves characters between the
    // name and the digest column cannot reproduce another file's entry.
    manifest.push(`${relative.length}:${relative}:${digest}`);
    filesRead += 1;
  }

  const hash = createHash('sha256');
  for (const entry of manifest.sort()) {
    hash.update(entry);
    hash.update('\n');
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

/** Moon's cache directories this gate has to be able to empty. */
const PURGED_DIRS = ['hashes', 'outputs'] as const;

/**
 * Empty Moon's cache so a stale entry cannot become eligible again.
 *
 * `--cache off` for one run is not enough, and the reason is specific. Moon's own
 * key does not contain `bun.lock` or a dependency project's sources, so a result
 * stored before those changed keeps exactly the key it had. Measured on this
 * workspace:
 *
 *   1. run under fingerprint F1          -> gate `off`, nothing stored
 *   2. run under F1                      -> gate `read-write`, stores H
 *   3. run under F1                      -> `cached, 0a00b1e9`
 *   4. edit bun.lock                     -> fingerprint F2, Moon's key unchanged
 *   5. run                               -> gate `off`, re-runs — but does NOT
 *                                           overwrite H, because `off` neither
 *                                           reads nor writes
 *   6. run again                         -> gate sees F2 unchanged, says
 *                                           `read-write`, and Moon restores H
 *
 * Step 6 is the defect: the gate had correctly detected the change, and the
 * result it then certified was computed against F1. Disabling the cache for a run
 * does not disable it for the *next* one.
 *
 * So on a mismatch the entries themselves go. `hashes/` holds the keys Moon would
 * match, `outputs/` holds the artifacts it would restore — including
 * `client:build`'s `.svelte-kit/cloudflare`, which is the only restorable output in
 * this workspace and the most expensive thing to certify wrongly. `states/` is
 * deliberately left alone: it holds Moon's version check and workspace graph,
 * which describe the tool rather than the tree, and rebuilding the graph costs
 * seconds on every run.
 *
 * Only ever called when the fingerprint has *changed*, so a warm run pays nothing.
 */
export const purgeMoonCache = (root: string = REPO_ROOT): { purged: string[] } => {
  const purged: string[] = [];

  for (const dir of PURGED_DIRS) {
    const path = join(root, '.moon', 'cache', dir);
    try {
      const entries = readdirSync(path);
      if (entries.length === 0) {
        continue;
      }
      rmSync(path, { recursive: true, force: true });
      purged.push(dir);
    } catch {
      // Absent or unreadable: there was nothing to purge, and saying so would be
      // noise. The caller already knows the tree changed.
    }
  }

  return { purged };
};

export const writeStamp = (root: string, fingerprint: string): void => {
  mkdirSync(join(root, '.moon', 'cache'), { recursive: true });
  writeFileSync(join(root, '.moon', 'cache', 'starter-inputs.sha256'), `${fingerprint}\n`);
};

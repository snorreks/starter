// scripts/src/smoke/template_smoke.ts
//
// Prove the template works for someone who has never seen this repository.
//
// Every other lane runs against this checkout, on this machine, with `bun`
// already on PATH, a `.moon/cache` warm, and a `.wrangler/` directory holding
// whatever the last run left. None of that is what a new user has. The question
// this answers is narrower and more useful: **starting from the committed tree
// alone, do the documented commands work?**
//
// The rehearsal:
//   1. copies the tree into a temporary directory, with no `.git`, no
//      `node_modules`, no build output and no local state — so a dependency on
//      any of those shows up as a missing file rather than as a warm cache;
//   2. gives it a synthetic project identity, so a renamed-but-committed
//      reference is caught and a maintainer's own name never leaks into the
//      report;
//   3. installs with `--frozen-lockfile`;
//   4. runs `setup`, which must succeed with no credential of any kind;
//   5. migrates and seeds a local D1;
//   6. builds;
//   7. runs the documented entrypoints that do not need a browser.
//
// Step 4 is the one that matters most and is the one that cannot be simulated:
// the committed `.env` files are gitignored, so a fresh copy has none, and
// `setup` has to create them from `LOCAL_ENV` without being handed a token.
//
// What it deliberately does NOT do is rename the project. `docs/rename-checklist.md`
// lists the exact places, and a blind global replacement would rewrite the
// license, the migration history and every code sample. The identity check here is
// narrow and reported, not performed.

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';

/** Seconds each step may take. A step that needs more is a step that has hung. */
const STEP_TIMEOUT_MS = 900_000;

/**
 * Never copied: a dependency on any of these is the bug this rehearsal finds.
 *
 * Names, not paths. `.moon` is deliberately *not* here: only `.moon/cache` is
 * gitignored, so `.moon/workspace.yml` and `.moon/toolchains.yml` are committed
 * configuration and `moon run` cannot resolve the workspace without them.
 * Excluding the directory by name was caught by this very rehearsal —
 * `bun run build` failed with `Unable to locate .moon/workspace.{yml,yaml,…}` in a
 * checkout that had one.
 */
const EXCLUDED = new Set([
  'node_modules',
  '.git',
  'cache',
  '.wrangler',
  '.svelte-kit',
  'build',
  'dist',
  'test-results',
  'playwright-report',
  '.cache',
  '.direnv',
  'artifacts',
  // Cargo's build directory. It is gitignored, it holds hundreds of megabytes
  // after one `cargo build`, and no clone of this repository contains it. Leaving
  // it in this set made `findIdentityReferences` walk a tree no template consumer
  // has: the smoke test then timed out at 5 s instead of finishing, and it timed
  // out for a developer's local build directory rather than for anything about
  // the template. `apps/backend/media` is the first first-party Cargo crate, so
  // this is the first time this set had to know what Cargo writes.
  'target',
]);

/** The one identity string a template consumer replaces. */
export const PROJECT_NAME = '@starter/monorepo';

export interface StepResult {
  step: string;
  ok: boolean;
  /** Milliseconds the step took. */
  durationMs: number;
  /** The tail of the combined output, for the failure report. */
  detail: string;
}

export interface SmokeReport {
  /** Absolute path of the temporary checkout. */
  dir: string;
  steps: StepResult[];
  ok: boolean;
  /** Committed references to the old identity, as `path:line`. */
  identityReferences: string[];
  /**
   * The `HOME` a step's child process actually saw, or null when no step ran.
   *
   * Reported rather than assumed. `.smoke-home` is created by this module before
   * any step runs, so the directory's existence says nothing about the environment
   * the children were given — and inheriting the maintainer's real home directory
   * is precisely the failure this rehearsal exists to rule out.
   */
  reportedHome: string | null;
}

/** Every file a clone of this repository would contain, as relative paths. */
export const committedFiles = (root: string = REPO_ROOT): string[] => {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (EXCLUDED.has(entry) || entry.startsWith('.git')) {
        continue;
      }
      const path = join(dir, entry);
      // `lstat`, so a symlinked directory is listed as the symlink it is and is
      // never walked into. `stat` would follow it and enumerate a tree that no
      // clone of this repository would contain.
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || stats.isFile()) {
        out.push(relative(root, path));
      } else if (stats.isDirectory()) {
        walk(path);
      }
    }
  };
  walk(root);
  return out.filter((file) => !isGitIgnored(root, file)).sort();
};

/**
 * Files allowed to name the template identity.
 *
 * Three kinds, and the reason each is here rather than tolerated:
 *
 *   * `docs/rename-checklist.md`, `AGENTS.md` — the instructions for changing it.
 *     A rename that rewrote these would delete the instructions.
 *   * `docs/starter-extraction.md` — the record of where this template came from.
 *     Rewriting provenance is not a rename.
 *   * `package.json` and `bun.lock` — the identity itself. There is nothing to
 *     rename until these change.
 *   * this module and its test — the checker. A checker that reported itself would
 *     be reporting its own constant.
 */
const IDENTITY_ALLOWED = new Set([
  'AGENTS.md',
  'docs/rename-checklist.md',
  'docs/smoke.md',
  'docs/starter-extraction.md',
  'package.json',
  'bun.lock',
  'scripts/src/smoke/template_smoke.ts',
  'scripts/tests/smoke.test.ts',
]);

/**
 * Committed references to the template identity.
 *
 * Everything outside `IDENTITY_ALLOWED` is a reference the first consumer has to
 * find by hand, which is the failure this list exists to make visible. Nothing is
 * rewritten: `docs/rename-checklist.md` is the deliberate, narrow operation, and a
 * global replacement here would rewrite the license and the migration history.
 */
export const findIdentityReferences = (root: string = REPO_ROOT): string[] => {
  const found: string[] = [];

  for (const file of committedFiles(root)) {
    let text: string;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    if (IDENTITY_ALLOWED.has(file.split(sep).join('/'))) {
      continue;
    }
    text.split('\n').forEach((line, index) => {
      if (line.includes(PROJECT_NAME) || line.includes('snorreks/starter')) {
        found.push(`${file}:${index + 1}`);
      }
    });
  }

  return found;
};

/**
 * Copy the committed tree into `to`, excluding everything `EXCLUDED` names.
 *
 * Exported so a test can assert on the copy itself. Asserting on the copy *after*
 * `bun install` has run proves nothing about the copy, because `install` creates a
 * fresh `node_modules` — which is exactly the mistake this export exists to avoid.
 */
export const copyTemplateTree = (from: string, to: string): string[] => {
  const copied: string[] = [];

  const walk = (source: string, target: string): void => {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source)) {
      // `cache` by name covers `.moon/cache`, `.pi/artifacts` and any other
      // generated directory whose *contents* are gitignored while its parent is
      // not. `.git` is matched by prefix because `.gitignore`, `.gitattributes`
      // and `.github` all start with it.
      if (EXCLUDED.has(entry) || entry.startsWith('.git')) {
        continue;
      }
      const sourcePath = join(source, entry);
      const targetPath = join(target, entry);

      // `lstat`, not `stat`: `stat` follows a symlink, so a symlinked *directory*
      // is reported as a directory and `walk` recurses into the tree behind it. That
      // can copy a maintainer's home directory, or `node_modules`, or `/`. A symlink
      // is copied as a symlink — which is what a checkout does — and never entered.
      const stats = lstatSync(sourcePath);
      if (stats.isSymbolicLink() || stats.isFile()) {
        // Decided *before* copying, not after. Filtering the returned list would
        // report a clean copy while the gitignored file sat on disk in the temporary
        // checkout, which is the thing being ruled out: a rehearsal that finds the
        // maintainer's `.env` present cannot distinguish "setup created it" from
        // "it was already there".
        //
        // `from` is the tree being copied, because `git check-ignore` is
        // repository-relative — a relative path from anywhere else names a file that
        // does not exist.
        const relativePath = relative(from, sourcePath);
        if (!isGitIgnored(from, relativePath)) {
          cpSync(sourcePath, targetPath);
          copied.push(relativePath);
        }
      } else if (stats.isDirectory()) {
        walk(sourcePath, targetPath);
      }
    }
  };
  walk(from, to);

  return copied;
};

/**
 * Is this path ignored by the repository's own `.gitignore`?
 *
 * Delegates to `git check-ignore` rather than reimplementing the pattern language.
 * The point of the rehearsal is to model a fresh clone, and a clone contains
 * exactly the files git tracks — so that is the question to ask. A hand-rolled
 * deny-list cannot know that `.env.example` is committed while `.env` is not, and
 * getting that backwards in either direction is the whole bug.
 *
 * `EXCLUDED` above is still doing work: it is a cheap filter for the large
 * directories that would otherwise be walked in full, and it is what keeps
 * `node_modules` out of the walk rather than out of the result.
 *
 * A repository without git — a fixture directory in a test — has nothing ignored,
 * so this returns false and the caller's `EXCLUDED` list remains authoritative.
 */
const isGitIgnored = (root: string, file: string): boolean => {
  const result = spawnSync('git', ['check-ignore', '--quiet', '--', file], {
    cwd: root,
    // Output is not wanted; only the status. `check-ignore` exits 0 for ignored,
    // 1 for not, and 128 when the path is outside the repository.
    stdio: 'ignore',
    timeout: 30_000,
  });

  return result.status === 0;
};

/** Run one step, bounded in time, and record what it cost and what it printed. */
const runStep = (step: string, cwd: string, args: string[]): StepResult => {
  const started = Date.now();
  const result = spawnSync('bun', args, {
    cwd,
    encoding: 'utf8',
    timeout: STEP_TIMEOUT_MS,
    // A rehearsal that inherits the maintainer's environment is not a rehearsal.
    // `HOME` goes to a directory inside the temporary checkout, so anything that
    // reaches for `~/.cache/ms-playwright` or `~/.bun` finds nothing.
    env: stepEnv(cwd),
  });

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return {
    step,
    // A signalled process reports `status: null`; treating that as 0 would certify
    // a step that was killed.
    ok: result.status === 0,
    durationMs: Date.now() - started,
    // The tail is what a reader needs. A `limit` on lines bounds readability, not
    // the memory a failing step can consume.
    detail: output.trim().split('\n').slice(-12).join('\n'),
  };
};

/**
 * The environment every step's child receives.
 *
 * One function, so the probe below and the real steps cannot disagree about what
 * was passed — which is the failure the probe exists to rule out.
 */
const stepEnv = (cwd: string): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? '',
  HOME: join(cwd, '.smoke-home'),
  STARTER_SKIP_SETUP: '1',
  CI: '1',
});

/** The `HOME` a child in `cwd` actually resolves. */
const probeHome = (cwd: string): string | null => {
  const result = spawnSync('bun', ['-e', 'process.stdout.write(process.env.HOME ?? "")'], {
    cwd,
    encoding: 'utf8',
    timeout: STEP_TIMEOUT_MS,
    env: stepEnv(cwd),
  });

  const home = (result.stdout ?? '').trim();
  return result.status === 0 && home !== '' ? home : null;
};

export interface SmokeOptions {
  /** The tree to rehearse. Defaults to this checkout. */
  root?: string;
  /** Keep the temporary checkout after the run. */
  keep?: boolean;
  /**
   * Stop after this many steps. Used by the tests to keep them quick.
   *
   * Must be a positive integer. Zero and negatives are rejected rather than
   * clamped: `plan.slice(0, 0)` returns nothing, `steps.length` then equals
   * `Math.min(0, 7)`, and `ok` is computed as "every step passed" over an empty
   * array — `true`. So `--steps=0` reported a successful rehearsal having executed
   * no step at all, which is the precise shape of failure this module exists to
   * detect in a template. Validated here as well as in the command, because the
   * library is exported and the command is only one of its callers.
   */
  maxSteps?: number;
}

/** Thrown when `maxSteps` is present but is not a positive integer. */
export class InvalidStepLimit extends Error {
  constructor(readonly value: unknown) {
    super(
      `maxSteps must be a positive integer, got ${JSON.stringify(value)}. ` +
        'Zero would run no step and then report ok.',
    );
    this.name = 'InvalidStepLimit';
  }
}

export const runTemplateSmoke = (options: SmokeOptions = {}): SmokeReport => {
  const root = options.root ?? REPO_ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'starter-smoke-'));
  const checkout = join(dir, 'starter');
  const steps: StepResult[] = [];

  try {
    copyTemplateTree(root, checkout);
    // `setup` writes into `$HOME`; give it one that exists and is disposable.
    mkdirSync(join(checkout, '.smoke-home'), { recursive: true });

    // Ask a child what `HOME` it sees, rather than trusting that the directory was
    // created and the env block was correct. Both halves of that are checked by the
    // same `stepEnv` the real steps use.
    const reportedHome = probeHome(checkout);

    // The documented order. `install` before everything because nothing resolves
    // without it; `build` before the entrypoints because the Worker lane serves
    // the built artifact.
    const plan: string[][] = [
      ['install', '--frozen-lockfile'],
      ['run', 'setup'],
      ['run', 'db:migrate'],
      ['run', 'db:seed'],
      ['run', 'build'],
      ['run', 'check:bundle'],
      ['run', 'setup:doctor'],
    ];

    const limit = options.maxSteps ?? plan.length;
    if (!Number.isInteger(limit) || limit < 1) {
      throw new InvalidStepLimit(options.maxSteps);
    }

    for (const args of plan.slice(0, limit)) {
      const step = runStep(args.join(' '), checkout, args);
      steps.push(step);
      // Stop at the first failure. A later step against a checkout that failed to
      // install reports a second, less informative failure.
      if (!step.ok) {
        break;
      }
    }

    return {
      dir: checkout,
      steps,
      ok: steps.length === Math.min(limit, plan.length) && steps.every((step) => step.ok),
      identityReferences: findIdentityReferences(root),
      reportedHome,
    };
  } finally {
    if (options.keep !== true) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
};

/** A repository-relative path with forward slashes, for a report line. */
export const displayPath = (file: string): string => file.split(sep).join('/');

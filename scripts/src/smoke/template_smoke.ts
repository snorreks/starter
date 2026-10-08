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
//   5. proves fresh local Supabase setup and database behavior;
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
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
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

/**
 * Does git track anything inside this directory?
 *
 * The answer decides whether a name in `EXCLUDED` means "generated output" or
 * only "a word this repository happens to use". `scripts/src/artifacts` holds a
 * committed source file — the Worker bundler `client:build` runs — and excluding
 * it by name deleted it from every rehearsal, where `bun run build` then failed
 * with `Module not found "../../../scripts/src/artifacts/bundle_worker.ts"`.
 *
 * A repository without git has nothing tracked here, which leaves the name-based
 * exclusion in charge: the same posture `isGitIgnored` takes for a fixture.
 */
const hasTrackedFiles = (root: string, directory: string): boolean => {
  const result = spawnSync('git', ['ls-files', '--', directory], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
  });

  return result.status === 0 && result.stdout.trim() !== '';
};

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
   * What the removal rehearsal actually deleted, as repository-relative paths.
   *
   * Reported rather than narrated. The command printed a fixed sentence naming four
   * directories and two workflows whether or not they existed, so a rehearsal that
   * removed nothing still claimed it had — and a reader checking the claim had no way
   * to tell. Empty means nothing was removed.
   */
  removed: string[];
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
      // not.
      //
      // `.git` is excluded by exact name, and nothing else starts with a prefix
      // match on it. The previous `startsWith('.git')` rule also dropped
      // `.gitignore`, `.gitattributes` and the whole `.github` directory — all of
      // which are committed files every clone has. Biome's `vcs.useIgnoreFile` then
      // failed on the copy with "couldn't find an ignore file", and the documented-
      // paths guard reported `.github/workflows/deploy.yml` as missing. The rehearsal
      // is a faithful clone, not a tidy one.
      //
      // A name in `EXCLUDED` is not applied here: at this point a file and a
      // directory are indistinguishable, and `scripts/src/artifacts` is a committed
      // source directory. The name is checked in the branch that knows which it is.
      if (entry === '.git') {
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
        if (!EXCLUDED.has(entry) && !isGitIgnored(from, relativePath)) {
          cpSync(sourcePath, targetPath);
          copied.push(relativePath);
        }
      } else if (stats.isDirectory()) {
        // The name is only a reason to skip when git tracks nothing inside it, so
        // the check happens here rather than in the loop's first condition: at that
        // point a file and a directory are still indistinguishable.
        if (EXCLUDED.has(entry) && !hasTrackedFiles(from, relative(from, sourcePath))) {
          continue;
        }
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
    env: templateStepEnvironment(cwd),
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
/**
 * The HOME every step's child is given.
 *
 * A *sibling* of the checkout, not a directory inside it. Inside it, Bun fills it
 * with a package cache on the first `install`, and then the whole-repository guard —
 * which walks everything it is handed — reports several thousand unclassified files
 * under a directory that no ownership rule could ever cover. The directory is inside
 * the same temporary root either way, so it is removed with the run.
 */
const smokeHome = (checkout: string): string => join(dirname(checkout), 'smoke-home');

export const templateStepEnvironment = (
  checkout: string,
  host: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => ({
  PATH: host.PATH ?? '',
  HOME: smokeHome(checkout),
  // Keep browser caches isolated but let the required rootless container engine
  // use its normal image store outside the temporary tree. Podman can create
  // id-mapped files there that the host cannot remove during smoke cleanup.
  XDG_DATA_HOME: host.XDG_DATA_HOME ?? join(host.HOME ?? smokeHome(checkout), '.local', 'share'),
  STARTER_SKIP_SETUP: '1',
  CI: '1',
});

/** The `HOME` a child in `cwd` actually resolves. */
const probeHome = (cwd: string): string | null => {
  const result = spawnSync('bun', ['-e', 'process.stdout.write(process.env.HOME ?? "")'], {
    cwd,
    encoding: 'utf8',
    timeout: STEP_TIMEOUT_MS,
    env: templateStepEnvironment(cwd),
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
   * Remove the native client and compute Worker examples from the copy before rehearsing.
   *
   * The rehearsal then asks the question a downstream project actually asks: does
   * the *web* half still install, build and pass its own guards once the native app
   * and the Rust processor are gone? The starter keeps both; the copy answers for
   * the version that keeps neither.
   *
   * The shared jobs package stays because web job routes import its portable
   * contracts. The deployable jobs Worker and media processor are removed from the
   * disposable copy, while the web app and shared Supabase database remain.
   */
  withoutHeavyExamples?: boolean;
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

/**
 * The heavy examples, and everything that names them.
 *
 * Rehearsed in a *disposable copy*, never in the template: this repository ships
 * both the native client and the compute example, and the question a downstream
 * project actually asks is "what happens if I delete them?". Answering it by
 * editing the template would trade a working example for a broken one.
 *
 * Deleting the directories is only half the rehearsal. The web workspace declares
 * `apps/frontend/*`, the Biome overrides name the native app, the guard policy
 * classifies it, and `package.json` has five `native:*` scripts — so a copy with
 * only the directories removed fails with an error about a missing project rather
 * than with anything about the web app. Each entry below is one such reference.
 */
export const HEAVY_EXAMPLES = {
  /** Directories removed wholesale. */
  directories: [
    'apps/frontend/native',
    'apps/backend/jobs',
    // The Rust/FFmpeg processor. Nothing in the web app imports it: the web Worker
    // reaches it only over HTTP through the jobs Worker, so deleting the crate
    // removes a container image and a Cargo workspace member without removing a
    // module the web half has to compile against.
    'apps/backend/media',
  ],
  /** Workflow files that only make sense with the native app present. */
  workflows: ['.github/workflows/native.yml', '.github/workflows/native-release.yml'],
  /**
   * Moon project ids pointing at a removed directory.
   *
   * Removed because Moon treats a `projects:` entry naming a missing path as a hard
   * error — `No project exists at source path apps/backend/media` — before it runs
   * a single task. Every lane that goes through `moon run` therefore fails on a
   * copy that has an example deleted but the workspace map left intact, which reads
   * as "the template is broken" rather than as "the workspace map still names it".
   */
  moonProjects: ['jobs-worker', 'media', 'native'],
  /** Root scripts that only make sense with the native app present. */
  packageScripts: [
    'native:doctor',
    'native:dev',
    'native:build',
    'native:android',
    'native:ios',
    'test:compute',
  ],
  /**
   * Biome override keys naming the removed trees.
   *
   * Edited by key rather than by rewriting the config file, because `biome.json`
   * is JSON and a regenerated file would lose the comments a reviewer reads.
   */
  biomeOverrideKeys: ['apps/frontend/native', 'apps/backend/jobs', 'apps/backend/media'],
} as const;

/**
 * Remove the heavy examples from a copied tree, and report what it touched.
 *
 * `root` is the disposable copy, never the repository: `copyTemplateTree` has
 * already made this checkout's contents disposable by the time this runs, and
 * every path here is resolved against `root`.
 */
/**
 * The guard's own exemption, reimplemented here on purpose.
 *
 * `scripts/src/guards/boundary.ts` refuses a document that names a path which does
 * not exist, and its remedy is: *say in the same sentence that it was removed*. So
 * the rehearsal does exactly that rather than deleting the prose — which would throw
 * away the parts of a README that still describe the web half.
 *
 * Duplicated because a rehearsal that imported the guard's private helper would be
 * testing the guard's regex against itself.
 */
const NARRATED =
  /\b(once had|once was|used to be|previously|former(ly)?|no longer|removed|renamed|moved|pointed at|does not exist|doesn'?t exist|is gone)\b/i;

/**
 * Rewrite the prose in a copy that names a removed example, so the whole-repository
 * guard passes for the right reason rather than being skipped.
 *
 * The note is inserted **immediately after the path**, not at the end of the line.
 * The guard checks the line and the paragraph separately, so a note parked at the end
 * of a multi-line block leaves the offending line unchanged and the guard still
 * refuses — which is what the first version of this function did.
 *
 * Two places are skipped:
 *   * fenced code blocks, byte for byte — a command sample naming the removed path is
 *     a historical sample, and a sentence inside a fence breaks the copy-paste;
 *   * lines that already read as narrated, so this is idempotent.
 */
/**
 * A literal, quoted for use inside a regular expression alternation.
 *
 * Not `escapeRegExp` from somewhere: one call, and a path segment can contain a dot
 * (`apps/backend/media/README.md`), which would otherwise match more than it names.
 */
const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The relative link targets on one line that no longer resolve.
 *
 * The guard checks *links*, not just bare paths: a README whose link target was
 * deleted renders as a broken link, which is the same reader-facing failure as a
 * sentence pointing at nothing. Narrating only the literal directory name would leave
 * `../media/README.md` untouched.
 */
const brokenLinkTargets = (root: string, file: string, line: string): string[] => {
  const base = dirname(join(root, file));
  const broken: string[] = [];

  for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1] as string;
    if (/^[a-z]+:/i.test(target) || target.startsWith('#') || target.startsWith('/')) {
      continue;
    }
    const [path] = target.split('#');
    if (path === undefined || path === '') {
      continue;
    }
    if (!existsSync(resolve(base, path))) {
      broken.push(target);
    }
  }

  return broken;
};

export const narrateRemovedReferences = (root: string, removed: readonly string[]): string[] => {
  const touched: string[] = [];
  const needle = removed.filter((path) => path !== '' && !path.includes('*'));

  for (const file of committedFiles(root)) {
    if (!file.endsWith('.md')) {
      continue;
    }
    const path = join(root, file);
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }

    let inFence = false;
    let changed = false;

    const lines = text.split('\n').map((line) => {
      if (line.trimStart().startsWith('```')) {
        inFence = !inFence;
        return line;
      }
      if (inFence || NARRATED.test(line)) {
        return line;
      }

      const candidates = [
        ...new Set([
          ...needle.filter((candidate) => line.includes(candidate)),
          ...brokenLinkTargets(root, file, line),
        ]),
      ].sort((left, right) => right.length - left.length);

      const hits = candidates.filter((candidate) => line.includes(candidate));
      if (hits.length === 0) {
        return line;
      }
      changed = true;

      // One pass, longest candidate first, over a single alternation.
      //
      // Reducing with `String.replace` per candidate corrupted overlapping
      // candidates: `apps/frontend/native` is a prefix of
      // `apps/frontend/native/src-tauri`, so annotating the short one first inserted
      // text *inside* the long one and the long one's own annotation then failed to
      // match — leaving `apps/frontend/native (removed in this copy)/src-tauri`,
      // which is neither path and matches neither exemption.
      const pattern = new RegExp(
        `(${hits.map((candidate) => escapeForRegExp(candidate)).join('|')})`,
        'g',
      );
      // Inserted after the path rather than appended, so the note stays in the same
      // cell/sentence and markdown tables and lists keep their shape.
      return line.replace(pattern, '$1 (removed in this copy)');
    });

    if (changed) {
      writeFileSync(path, lines.join('\n'), 'utf8');
      touched.push(file);
    }
  }

  return touched;
};

export const removeHeavyExamples = (root: string): string[] => {
  const touched: string[] = [];

  for (const relative of HEAVY_EXAMPLES.directories) {
    const path = join(root, relative);
    if (existsSync(path)) {
      rmSync(path, { recursive: true, force: true });
      touched.push(relative);
    }
  }

  for (const relative of HEAVY_EXAMPLES.workflows) {
    const path = join(root, relative);
    if (existsSync(path)) {
      rmSync(path, { force: true });
      touched.push(relative);
    }
  }

  const workspacePath = join(root, '.moon/workspace.yml');
  if (existsSync(workspacePath)) {
    // Line-filtered rather than parsed: the file is hand-maintained and heavily
    // commented, and this runs against a disposable copy where rewriting it wholesale
    // would cost more than it proves. Only the mapping lines are dropped; the
    // surrounding prose is left where it is, which is why the rehearsal's own output
    // names what it removed.
    const kept = readFileSync(workspacePath, 'utf8')
      .split('\n')
      .filter(
        (line) =>
          !HEAVY_EXAMPLES.moonProjects.some((id) => new RegExp(`^\\s*${id}:\\s*'`).test(line)),
      );
    writeFileSync(workspacePath, kept.join('\n'), 'utf8');
    touched.push('.moon/workspace.yml');
  }

  const manifestPath = join(root, 'package.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    for (const name of HEAVY_EXAMPLES.packageScripts) {
      if (manifest.scripts !== undefined && name in manifest.scripts) {
        delete manifest.scripts[name];
        touched.push(`package.json#scripts.${name}`);
      }
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }

  const biomePath = join(root, 'biome.json');
  if (existsSync(biomePath)) {
    const biome = JSON.parse(readFileSync(biomePath, 'utf8')) as {
      files?: { includes?: string[] };
      overrides?: Array<{ includes?: string[] }>;
    };
    const prune = (value: string[]): string[] =>
      value.filter(
        (entry) => !HEAVY_EXAMPLES.biomeOverrideKeys.some((key) => entry.startsWith(key)),
      );

    if (Array.isArray(biome.files?.includes)) {
      biome.files.includes = prune(biome.files.includes);
    }
    if (Array.isArray(biome.overrides)) {
      biome.overrides = biome.overrides
        .map((entry) =>
          entry.includes === undefined ? entry : { ...entry, includes: prune(entry.includes) },
        )
        // An override whose every pattern names a removed tree is dropped rather
        // than left with an empty `includes`. Biome rejects an empty pattern list as
        // a configuration error, and the symptom — "Biome exited because the
        // configuration resulted in errors", printed against an unrelated project —
        // points at the wrong file entirely.
        .filter((entry) => entry.includes === undefined || entry.includes.length > 0);
    }
    writeFileSync(biomePath, `${JSON.stringify(biome, null, 2)}\n`, 'utf8');
    touched.push('biome.json');
  }

  const narrated = narrateRemovedReferences(root, [
    ...HEAVY_EXAMPLES.directories,
    ...HEAVY_EXAMPLES.workflows,
  ]);

  return [...touched, ...narrated];
};

export const runTemplateSmoke = (options: SmokeOptions = {}): SmokeReport => {
  const root = options.root ?? REPO_ROOT;
  const dir = mkdtempSync(join(tmpdir(), 'starter-smoke-'));
  const checkout = join(dir, 'starter');
  const steps: StepResult[] = [];

  const removed: string[] = [];

  try {
    copyTemplateTree(root, checkout);
    if (options.withoutHeavyExamples === true) {
      removed.push(...removeHeavyExamples(checkout));
    }
    // `setup` writes into `$HOME`; give it one that exists and is disposable.
    mkdirSync(smokeHome(checkout), { recursive: true });

    // Ask a child what `HOME` it sees, rather than trusting that the directory was
    // created and the env block was correct. Both halves of that are checked by the
    // same `templateStepEnvironment` the real steps use.
    const reportedHome = probeHome(checkout);

    // The documented order. `install` before everything because nothing resolves
    // without it; `build` before the entrypoints because the Worker lane serves
    // the built artifact.
    // Removing a workspace makes `bun.lock` stale, and `--frozen-lockfile`
    // correctly refuses a stale lockfile rather than silently rewriting it. So the
    // removal rehearsal installs once *without* the flag to regenerate, and then
    // immediately re-runs `--frozen-lockfile` to prove the regenerated lockfile is
    // clean. A downstream project that deletes an example has to do this too, which
    // is exactly the thing worth discovering in a rehearsal rather than in
    // production.
    const installSteps: string[][] =
      options.withoutHeavyExamples === true
        ? [['install'], ['install', '--frozen-lockfile']]
        : [['install', '--frozen-lockfile']];

    // `typecheck`, `lint` and `guard` are in the plan because the rehearsal that
    // only proves `build` succeeds is the one that misses a reference the web app
    // still has to the deleted example. `guard` in particular is what catches a
    // boundary that still imports from `apps/frontend/native`.
    const plan: string[][] = [
      ...installSteps,
      ['run', 'setup'],
      ['run', 'test:database'],
      ['run', 'build'],
      ['run', 'check:bundle'],
      ['run', 'typecheck'],
      ['run', 'lint'],
      ['run', 'guard'],
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
      removed,
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

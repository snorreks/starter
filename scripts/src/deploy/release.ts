// scripts/src/deploy/release.ts
//
// What was actually published, and what it was built from.
//
// A deploy that prints "done" and exits 0 answers one question — did the command
// succeed — and leaves three others unanswered: which source, which bytes, and
// which deployment is now serving. Those are the questions you have when the
// release is on fire, so they are answered once, at deploy time, and written
// down.
//
// The record is deliberately a *description of a fact that already happened*, not
// a decision about the next deploy. In particular there is no skip-if-unchanged
// logic and no fingerprint engine: this module never decides whether to deploy.
//
//   * `digestArtifact` is a plain content hash over the built directory. It is a
//     record of identity, not a deployment gate — two builds of the same source
//     differ, because the bundler stamps them, and that is correct: the bytes that
//     shipped are the bytes that are hashed.
//   * Whether to deploy is the operator's call, made through `--yes`. That is a
//     worse feature and a safer default: a custom skip-deployment engine is a
//     cache whose invalidation is a correctness problem, and a cache that decides
//     on its own that nothing changed is a cache that eventually decides wrongly.
//
// Everything here is hashed from *file contents and relative paths* only. The
// digest never includes a timestamp, a hostname or a secret, so two builds of the
// same tree agree, and the value is safe to put in a CI summary and a ticket.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';

/** Where release records live. Gitignored, so a record never lands in a diff. */
export const RELEASES_DIR = '.starter/releases';

/**
 * Content digest of a built artifact.
 *
 * Every file under `dir`, sorted by relative path, hashed as
 * `path\0sha256(contents)`. The path is inside the hash so a rename is a
 * different artifact even when the bytes are identical — a Worker whose asset
 * moved is a different Worker.
 *
 * Returns `null` when the directory does not exist, rather than the digest of
 * nothing: a caller that treated "absent" as "the empty artifact" would record a
 * successful release of a build that never happened.
 */
export const digestArtifact = (dir: string): string | null => {
  if (!existsSync(dir)) {
    return null;
  }

  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  walk(dir);

  const hash = createHash('sha256');
  // `sep` normalises so the same tree on two platforms produces the same digest.
  for (const file of files.sort()) {
    hash.update(relative(dir, file).split(sep).join('/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }

  return `sha256:${hash.digest('hex')}`;
};

/**
 * The full artifact, or a reason it is not one.
 *
 * The distinction that matters: a directory containing files is not necessarily a
 * Worker. `wrangler deploy` against assets with no `_worker.js` publishes a
 * static site whose every route 404s and reports success, so the entrypoint is
 * checked here rather than inferred from "the build exited 0".
 */
export interface ArtifactCheck {
  ok: boolean;
  digest: string | null;
  fileCount: number;
  problems: string[];
}

export const inspectArtifact = (dir: string): ArtifactCheck => {
  const problems: string[] = [];

  if (!existsSync(dir)) {
    return {
      ok: false,
      digest: null,
      fileCount: 0,
      problems: [
        `No built artifact at ${dir}. Run \`bun run build\` first — a deploy with no ` +
          '_worker.js publishes assets alone and reports success, leaving a site where ' +
          'every route 404s.',
      ],
    };
  }

  const hasWorker = existsSync(join(dir, '_worker.js'));
  if (!hasWorker) {
    problems.push(
      `${dir} has no _worker.js. This is a static asset directory, not a Worker: ` +
        '`wrangler deploy` would publish it and report success, and every route would 404.',
    );
  }

  let fileCount = 0;
  const count = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        count(full);
      } else if (entry.isFile()) {
        fileCount += 1;
      }
    }
  };
  count(dir);

  if (fileCount === 0) {
    problems.push(`${dir} is empty. A restored Moon cache with no output is not a build.`);
  }

  const digest = digestArtifact(dir);

  return {
    ok: problems.length === 0,
    digest,
    fileCount,
    problems,
  };
};

/**
 * The source revision an artifact was built from.
 *
 * Read from git rather than passed in, because a caller that passes it can pass
 * the wrong one and a release record with the wrong SHA is worse than none: it
 * looks authoritative while pointing at a commit that was never built.
 *
 * Falls back to an explicit environment override, which is what a build from an
 * exported source tree (no `.git`) uses. The fallback is recorded as such rather
 * than silently substituting the branch name.
 */
export const sourceRevision = (
  root: string = REPO_ROOT,
  env: NodeJS.ProcessEnv = process.env,
): { sha: string; source: 'git' | 'environment' } => {
  const override = env.SOURCE_REVISION?.trim();
  if (override !== undefined && /^[0-9a-f]{7,40}$/i.test(override)) {
    return { sha: override.toLowerCase(), source: 'environment' };
  }

  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? { sha, source: 'git' } : { sha, source: 'environment' };
  } catch {
    // No git, or not a checkout. `SOURCE_REVISION` is the documented route; say so
    // rather than recording a placeholder that reads like a real SHA.
    return { sha: 'unknown', source: 'environment' };
  }
};

/** What a smoke check found, with no response body retained. */
export interface SmokeResult {
  ok: boolean;
  /** The path that was fetched, e.g. `/health`. */
  path: string;
  status: number | null;
  /** The release id the endpoint reported, when it reported one. */
  reportedRelease: string | null;
  /** A failure description. Never a response body: it may contain user data. */
  problem: string | null;
}

export interface ReleaseRecord {
  project: string;
  environment: string;
  accountId: string;
  workerName: string;
  origin: string;
  sourceSha: string;
  artifactDigest: string;
  /** Cloudflare's own identity for the deployed release. */
  deploymentId: string | null;
  versionId: string | null;
  recordedAt: string;
  smoke: SmokeResult | null;
}

export const releaseRecordPath = (environment: string, root: string = REPO_ROOT): string =>
  join(root, RELEASES_DIR, `${environment}.json`);

/**
 * Write a release record.
 *
 * The digest is required, so there is no way to record a release whose artifact
 * was never hashed — which is the record that would be a guess.
 */
export const writeReleaseRecord = (record: ReleaseRecord, root: string = REPO_ROOT): string => {
  const path = releaseRecordPath(record.environment, root);
  mkdirSync(join(root, RELEASES_DIR), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return path;
};

/** Read a release record, or `null` when there is none or it is unreadable. */
export const readReleaseRecord = (
  environment: string,
  root: string = REPO_ROOT,
): ReleaseRecord | null => {
  const path = releaseRecordPath(environment, root);
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') {
      return null;
    }
    return parsed as ReleaseRecord;
  } catch {
    return null;
  }
};

/**
 * Render a release record for a human or a CI summary.
 *
 * Contains no credential, no token and no response body by construction: every
 * field is either a name, a hash or a status.
 */
export const renderReleaseRecord = (record: ReleaseRecord): string => {
  // Extracted rather than inlined as a nested ternary: a three-way conditional
  // inside a template literal is unreadable precisely when it matters most — a
  // failed smoke result at 3am.
  const smokeLine = ((): string => {
    if (record.smoke === null) {
      return 'not run';
    }
    if (!record.smoke.ok) {
      return `FAILED (${record.smoke.path}: ${record.smoke.problem ?? 'unknown'})`;
    }
    return `ok (${record.smoke.path} -> ${record.smoke.status}, release ${record.smoke.reportedRelease ?? 'unreported'})`;
  })();

  return [
    `Release recorded (${record.environment})`,
    `  project        ${record.project}`,
    `  worker         ${record.workerName}  (account ${record.accountId})`,
    `  origin         ${record.origin}`,
    `  source         ${record.sourceSha}`,
    `  artifact       ${record.artifactDigest}`,
    `  deployment     ${record.deploymentId ?? 'not reported by the provider'}`,
    `  version        ${record.versionId ?? 'not reported by the provider'}`,
    `  smoke          ${smokeLine}`,
    `  recorded       ${record.recordedAt}`,
  ].join('\n');
};

/** Bound a directory walk so a stray symlink cannot make this run forever. */
export const withinFile = (dir: string, name: string): boolean => {
  const full = join(dir, name);
  try {
    return statSync(full).isFile();
  } catch {
    return false;
  }
};

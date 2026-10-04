// scripts/src/ci/evidence.ts
//
// One small, machine-readable record of what was actually run, and a check that
// the capability matrix agrees with it.
//
// ── Why this is a file and not a test-results database ─────────────────────────
//
// The problem it solves is specific: docs/capability-matrix.md advertised counts
// from a round that had been superseded, with no revision attached, so "883 unit
// tests" and "52 Worker tests" were both true at some point and a reader could not
// tell which described the branch they were holding.
//
// The fix is not a results database and not a new runner. It is a manifest of
// *claims*, each one carrying the revision it was observed on, the platform, the
// exact command, the count the command printed, the timestamp and the artifact.
// `bun run evidence` then checks that the current section of the matrix is what
// this manifest renders — so a count cannot drift without a check failing.
//
// Historical results are retained verbatim in the same manifest, under their own
// revision and timestamp. They are not deleted: "this used to be faster" is
// information, and a manifest that only remembers the latest run cannot answer
// whether a lane regressed.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../shared/paths.ts';

/** Where the manifest lives. Small, committed, hand-edited after a real run. */
export const EVIDENCE_MANIFEST_PATH = 'docs/evidence/current.json';

/**
 * What kind of proof a row carries.
 *
 * The three are not interchangeable and conflating them is the failure this file
 * exists to prevent:
 *
 *   * `observed` — the command ran here, on this revision, and printed this.
 *   * `not-run`  — the check exists and was *not* executed here, with the cause.
 *     A `not-run` row is required for anything a reader would otherwise assume.
 *   * `historical` — observed on an earlier revision, retained for comparison.
 */
export const EVIDENCE_KINDS = ['observed', 'not-run', 'historical'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface EvidenceRow {
  /** The capability, in the operator's words. One per lane. */
  capability: string;
  kind: EvidenceKind;
  /** The revision this row describes. Required even for `not-run`: "current" is a claim. */
  revision: string;
  /** The exact command, so the row is reproducible rather than descriptive. */
  command: string;
  /** `linux-x64`, `macos-arm64`, … Never "linux". */
  platform: string;
  /** What the command printed, in the operator's words. A count, or `n/a`. */
  result: string;
  /** A count, when the command reports one. `null` when it does not. */
  count: number | null;
  /** ISO-8601. The moment the command ran, not the moment the file was edited. */
  recordedAt: string;
  /** Where the full output lives, if it was kept. A relative path or a URL. */
  artifact: string | null;
  /** Required for `not-run`. The exact cause and the command that would run it. */
  reason?: string;
}

export interface EvidenceManifest {
  /** The revision the *current* rows describe. */
  revision: string;
  rows: EvidenceRow[];
}

/** The revision this checkout is at. Used to check the manifest is not stale. */
export const currentRevision = (root: string = REPO_ROOT): string | null => {
  const head = join(root, '.git', 'HEAD');
  if (!existsSync(head)) {
    return null;
  }
  const text = readFileSync(head, 'utf8').trim();
  const match = /([0-9a-f]{40})/.exec(text);
  return match?.[1] ?? null;
};

export type ManifestResult =
  | { ok: true; manifest: EvidenceManifest }
  | { ok: false; problems: string[] };

/**
 * Read and check the manifest.
 *
 * The checks are the point. A JSON file with no invariants is a place to put
 * anything, and the failure it is meant to prevent — a matrix claiming a count no
 * run produced — is exactly what an unvalidated manifest permits.
 */
export const readManifest = (root: string = REPO_ROOT): ManifestResult => {
  const path = join(root, EVIDENCE_MANIFEST_PATH);
  if (!existsSync(path)) {
    return {
      ok: false,
      problems: [
        `${EVIDENCE_MANIFEST_PATH} is missing. It is the record the capability matrix is ` +
          'derived from; without it the matrix is a claim with nothing behind it.\n' +
          '  bun run evidence --write   # creates it from the rows this run observed',
      ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      problems: [
        `${EVIDENCE_MANIFEST_PATH} is not valid JSON: ${
          error instanceof Error ? error.message : 'parse error'
        }`,
      ],
    };
  }

  const manifest = parsed as EvidenceManifest;
  const problems: string[] = [];

  if (typeof manifest.revision !== 'string' || !/^[0-9a-f]{7,40}$/.test(manifest.revision)) {
    problems.push(`\`revision\` must be a git SHA; got ${JSON.stringify(manifest.revision)}.`);
  }

  if (!Array.isArray(manifest.rows) || manifest.rows.length === 0) {
    problems.push('`rows` must be a non-empty array. An empty manifest proves nothing.');
  } else {
    const seen = new Set<string>();
    for (const [index, row] of manifest.rows.entries()) {
      const at = `rows[${index}] (${row?.capability ?? 'unnamed'})`;
      if (!(EVIDENCE_KINDS as readonly string[]).includes(row?.kind)) {
        problems.push(`${at}: kind must be one of ${EVIDENCE_KINDS.join(', ')}.`);
      }
      if (typeof row?.command !== 'string' || row.command.trim() === '') {
        problems.push(`${at}: a command is required, so the row is reproducible.`);
      }
      if (typeof row?.platform !== 'string' || row.platform.trim() === '') {
        problems.push(`${at}: a platform is required; "linux" alone does not identify a host.`);
      }
      if (!/^\d{4}-\d{2}-\d{2}T/.test(String(row?.recordedAt))) {
        problems.push(`${at}: recordedAt must be an ISO-8601 timestamp.`);
      }
      if (row?.kind === 'not-run' && (row.reason === undefined || row.reason.trim() === '')) {
        // The row that matters most. A `not-run` row with no reason reads as "not
        // important", which is the opposite of what it means.
        problems.push(`${at}: a not-run row must say why, and what command would run it.`);
      }
      if (row?.kind === 'observed' && !Number.isInteger(row.count) && row.count !== null) {
        problems.push(`${at}: an observed row's count must be an integer or null.`);
      }
      if (seen.has(row?.capability)) {
        problems.push(`${at}: duplicate capability; one row per capability per revision.`);
      }
      seen.add(row?.capability);
    }
  }

  return problems.length === 0 ? { ok: true, manifest } : { ok: false, problems };
};

/**
 * Render the manifest's current rows as the markdown table the matrix embeds.
 *
 * Only `observed` and `not-run` rows: a historical row belongs under its own dated
 * heading, where it cannot be mistaken for a statement about this revision.
 */
export const renderCurrentMatrix = (manifest: EvidenceManifest): string => {
  const header = [
    `<!-- generated by \`bun run evidence --check\` from ${EVIDENCE_MANIFEST_PATH}. Do not hand-edit. -->`,
    '',
    `Revision \`${manifest.revision}\`. Every row below was executed at the timestamp shown,`,
    'on the platform shown, by the command shown. A `not-run` row is present on purpose.',
    '',
    '| Capability | Command | Platform | Result | When | Artifact |',
    '|---|---|---|---|---|---|',
  ];

  const body = manifest.rows
    .filter((row) => row.kind !== 'historical')
    .map((row) => {
      const result =
        row.kind === 'not-run' ? `NOT RUN — ${row.reason ?? 'no reason recorded'}` : row.result;
      const artifact = row.artifact === null ? '—' : `[${row.artifact}](${row.artifact})`;
      return `| ${row.capability} | \`${row.command}\` | ${row.platform} | ${result} | ${row.recordedAt} | ${artifact} |`;
    });

  return [...header, ...body].join('\n');
};

/** The markers the generated block lives between, so the check can find it again. */
export const MATRIX_BEGIN = '<!-- evidence:current:begin -->';
export const MATRIX_END = '<!-- evidence:current:end -->';

/**
 * Whether docs/capability-matrix.md carries the block this manifest renders.
 *
 * A mismatch is reported with the first differing line, because "the matrix is out
 * of date" is a much worse error message than the line that differs.
 */
export const matrixMatches = (
  manifest: EvidenceManifest,
  root: string = REPO_ROOT,
): { ok: boolean; detail: string } => {
  const path = join(root, 'docs/capability-matrix.md');
  if (!existsSync(path)) {
    return { ok: false, detail: 'docs/capability-matrix.md is missing.' };
  }

  const text = readFileSync(path, 'utf8');
  const begin = text.indexOf(MATRIX_BEGIN);
  const end = text.indexOf(MATRIX_END);

  if (begin === -1 || end === -1 || end < begin) {
    return {
      ok: false,
      detail:
        'docs/capability-matrix.md has no generated block. It must contain\n' +
        `  ${MATRIX_BEGIN}\n  ...\n  ${MATRIX_END}\n` +
        '  bun run evidence --write   # inserts it',
    };
  }

  const existing = text.slice(begin + MATRIX_BEGIN.length, end).trim();
  const expected = renderCurrentMatrix(manifest).trim();

  if (existing === expected) {
    return { ok: true, detail: 'the capability matrix matches the evidence manifest.' };
  }

  const existingLines = existing.split('\n');
  const expectedLines = expected.split('\n');
  const at = existingLines.findIndex((line, index) => line !== expectedLines[index]);
  const where = at === -1 ? existingLines.length : at + 1;

  return {
    ok: false,
    detail:
      `docs/capability-matrix.md does not match ${EVIDENCE_MANIFEST_PATH}, first differing line ` +
      `${where}:\n` +
      `  matrix:    ${existingLines[at] ?? '(block ends here)'}\n` +
      `  manifest:  ${expectedLines[at] ?? '(block ends here)'}\n` +
      '  bun run evidence --write',
  };
};

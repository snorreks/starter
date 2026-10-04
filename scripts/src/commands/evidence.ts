// scripts/src/commands/evidence.ts
//
// `bun run evidence --check` — the capability matrix may not disagree with the
// manifest it is derived from.
//
// A check rather than a generator, deliberately. A generator that runs the lanes
// would be a second test runner, and the round-2 review asked for neither a new
// runner nor a results database. This one reads two committed files and compares
// them, which is cheap, runs in CI with no credentials, and fails loudly the moment
// somebody edits a count in the matrix by hand.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EVIDENCE_MANIFEST_PATH,
  type EvidenceManifest,
  MATRIX_BEGIN,
  MATRIX_END,
  matrixMatches,
  readManifest,
  renderCurrentMatrix,
  revisionIsReachable,
} from '../ci/evidence.ts';
import { type Command, EXIT, fail, wantsHelp } from '../shared/command.ts';
import { REPO_ROOT } from '../shared/paths.ts';

const MATRIX = 'docs/capability-matrix.md';

const USAGE = `evidence [--check] [--write]

The capability matrix is derived from ${EVIDENCE_MANIFEST_PATH}: each row carries the
revision it was observed on, the platform, the exact command, the count the command
printed, the timestamp and the artifact.

  --check   compare the two. The default, and what CI runs. Read-only, no credentials.
  --write   re-render the generated block in ${MATRIX} from the manifest.

A 'not-run' row is required for any check that exists and was not executed here; it
must carry the cause and the command that would run it.`;

const writeMatrix = (manifest: EvidenceManifest): number => {
  const path = join(REPO_ROOT, MATRIX);
  if (!existsSync(path)) {
    return fail(`${MATRIX} does not exist. Nothing was written.`, EXIT.failed);
  }

  const text = readFileSync(path, 'utf8');
  const begin = text.indexOf(MATRIX_BEGIN);
  const end = text.indexOf(MATRIX_END);

  if (begin === -1 || end === -1 || end < begin) {
    return fail(
      `${MATRIX} has no generated block. It must contain\n` +
        `  ${MATRIX_BEGIN}\n  ...\n  ${MATRIX_END}\n` +
        '  Nothing was written.',
      EXIT.failed,
    );
  }

  const rendered = `${MATRIX_BEGIN}\n${renderCurrentMatrix(manifest)}\n${MATRIX_END}`;
  writeFileSync(
    path,
    `${text.slice(0, begin)}${rendered}${text.slice(end + MATRIX_END.length)}`,
    'utf8',
  );

  process.stdout.write(`${MATRIX} regenerated from ${EVIDENCE_MANIFEST_PATH}. Nothing was run.\n`);
  return EXIT.ok;
};

export const evidenceCommand: Command = {
  name: 'evidence',
  summary: 'check the capability matrix against the evidence manifest',
  usage: USAGE,

  run(argv) {
    if (wantsHelp(argv)) {
      process.stdout.write(`${USAGE}\n`);
      return EXIT.ok;
    }

    const known = new Set(['--check', '--write']);
    const unknown = argv.filter((arg) => !known.has(arg));
    if (unknown.length > 0) {
      return fail(`Unknown flag "${unknown[0]}"\n\n${USAGE}`, EXIT.usage);
    }

    // Both flags is two different questions in one invocation, and `--write` would win
    // silently — a run that asked to *check* would rewrite the document it was
    // checking. Refused rather than resolved.
    if (argv.includes('--check') && argv.includes('--write')) {
      return fail(
        '`--check` and `--write` are different questions; pass one.\n' +
          '  Nothing was written.\n' +
          '    --check   is the document still what the manifest says? (what CI runs)\n' +
          '    --write   regenerate it from the manifest\n',
        EXIT.usage,
      );
    }

    const manifest = readManifest();
    if (!manifest.ok) {
      process.stderr.write(`${manifest.problems.join('\n\n')}\n\nNothing was checked.\n`);
      return EXIT.failed;
    }

    if (argv.includes('--write')) {
      return writeMatrix(manifest.manifest);
    }

    // Reachability, before the matrix comparison: a manifest describing a revision
    // this branch does not contain is wrong regardless of whether the table matches.
    const reachable = revisionIsReachable(manifest.manifest.revision);
    if (reachable === false) {
      return fail(
        `${EVIDENCE_MANIFEST_PATH} describes revision ${manifest.manifest.revision}, which is not\n` +
          '  an ancestor of this checkout. Every count in it was observed on code this branch\n' +
          '  does not contain, so none of them describes what is here.\n' +
          '  Re-run the lanes and record this revision:\n' +
          '    bun run test && bun run test:browser && bun run test:worker && bun run e2e\n' +
          '  Nothing was changed.',
        EXIT.failed,
      );
    }

    const match = matrixMatches(manifest.manifest);
    if (match.ok) {
      process.stdout.write(
        `ok  ${manifest.manifest.rows.length} evidence row(s) at ${manifest.manifest.revision}; ` +
          'the capability matrix matches.' +
          // Said rather than omitted: a reader who cannot tell whether the check ran
          // assumes it did, which is the failure this whole mechanism exists to avoid.
          (reachable === null
            ? ' (revision reachability NOT CHECKED: no git repository here)\n'
            : '\n'),
      );
      return EXIT.ok;
    }

    process.stderr.write(`${match.detail}\n`);
    return EXIT.failed;
  },
};

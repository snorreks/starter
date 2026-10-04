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

    const manifest = readManifest();
    if (!manifest.ok) {
      process.stderr.write(`${manifest.problems.join('\n\n')}\n\nNothing was checked.\n`);
      return EXIT.failed;
    }

    if (argv.includes('--write')) {
      return writeMatrix(manifest.manifest);
    }

    const match = matrixMatches(manifest.manifest);
    if (match.ok) {
      process.stdout.write(
        `ok  ${manifest.manifest.rows.length} evidence row(s) at ${manifest.manifest.revision}; ` +
          'the capability matrix matches.\n',
      );
      return EXIT.ok;
    }

    process.stderr.write(`${match.detail}\n`);
    return EXIT.failed;
  },
};

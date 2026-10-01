// apps/backend/api/scripts/ensure_local_d1.ts
//
// Prepare the local D1 for a test run: fresh state, then migrations.
//
// Deliberately deletes `.wrangler/state` first. A test that can pass or fail
// depending on what a previous run left in the local database is not a test.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `import.meta.url` is this file's URL: four levels up from
// apps/backend/api/scripts/ reaches the repository root. Getting this depth
// wrong is silent and reads as a missing config file, so `scripts/tests/paths.test.ts`
// guards the shared copy and `test:prepare` fails loudly on the wrong path.
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');

const API_DIR = join(REPO_ROOT, 'apps/backend/api');
const CONFIG = join(API_DIR, 'wrangler.jsonc');
const STATE = join(API_DIR, '.wrangler/state');

/**
 * The pinned workspace copy of wrangler.
 *
 * `bunx wrangler` from the repository root does not find a binary that only this
 * package depends on, so it downloads whatever npm serves that day — observed here
 * as 4.145.0 against a lockfile pin of 4.142.0. A test that prepares a database
 * with a different tool version than the one the project validated is not testing
 * the project's configuration.
 */
const WRANGLER = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '.bin',
  'wrangler',
);

export const prepare = (): void => {
  rmSync(STATE, { recursive: true, force: true });

  if (!existsSync(WRANGLER)) {
    throw new Error(
      `wrangler is not installed at ${WRANGLER}. Run \`bun install\` from the repository root.`,
    );
  }

  const result = spawnSync(
    WRANGLER,
    ['d1', 'migrations', 'apply', 'DB', '--local', '--config', CONFIG],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );

  if (result.status !== 0) {
    process.stderr.write(`${result.stdout ?? ''}\n${result.stderr ?? ''}\n`);
    throw new Error('Local migration failed.');
  }
};

if (import.meta.main) {
  if (!existsSync(CONFIG)) {
    process.stderr.write(`Missing ${CONFIG}\n`);
    process.exitCode = 1;
  } else {
    prepare();
    process.stdout.write('Local D1 prepared.\n');
  }
}

// apps/backend/api/scripts/ensure_local_d1.ts
//
// Prepare the local D1 for a test run: fresh state, then migrations.
//
// Deliberately deletes `.wrangler/state` first. A test that can pass or fail
// depending on what a previous run left in the local database is not a test.

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// `import.meta.url` is the file's URL: four levels up from
// apps/backend/api/scripts/ reaches the repository root.
const REPO_ROOT = new URL('../../../../', import.meta.url).pathname.replace(/\/$/, '');

const API_DIR = join(REPO_ROOT, 'apps/backend/api');
const CONFIG = join(API_DIR, 'wrangler.jsonc');
const STATE = join(API_DIR, '.wrangler/state');

export const prepare = (): void => {
  rmSync(STATE, { recursive: true, force: true });

  const result = spawnSync(
    'bunx',
    ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', CONFIG],
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

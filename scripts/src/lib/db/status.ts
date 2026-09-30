// scripts/src/lib/db/status.ts
//
// Show which migrations have been applied locally, and whether the local
// database exists at all. Read-only.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './migrate.ts';

const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/backend/database/drizzle-d1');
const API_DIR = join(REPO_ROOT, 'apps/backend/api');

export const main = (): number => {
  if (!existsSync(MIGRATIONS_DIR)) {
    process.stderr.write('No migrations directory. Run `bun run db:generate`.\n');
    return 1;
  }

  process.stdout.write('Local migrations:\n');
  const result = spawnSync(
    'bunx',
    [
      'wrangler',
      'd1',
      'migrations',
      'list',
      'DB',
      '--local',
      '--config',
      join(API_DIR, 'wrangler.jsonc'),
    ],
    { stdio: 'inherit', cwd: REPO_ROOT },
  );
  return result.status ?? 1;
};

if (import.meta.main) {
  process.exitCode = main();
}

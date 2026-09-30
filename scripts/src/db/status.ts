// scripts/src/lib/db/status.ts
//
// Show which migrations have been applied locally, and whether the local
// database exists at all. Read-only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runWrangler } from '../cloudflare/wrangler.ts';
import { API_DIR, REPO_ROOT } from '../shared/paths.ts';

const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/backend/database/drizzle-d1');

export const main = (): number => {
  if (!existsSync(MIGRATIONS_DIR)) {
    process.stderr.write('No migrations directory. Run `bun run db:generate`.\n');
    return 1;
  }

  process.stdout.write('Local migrations:\n');
  return runWrangler([
    'd1',
    'migrations',
    'list',
    'DB',
    '--local',
    '--config',
    join(API_DIR, 'wrangler.jsonc'),
  ]);
};

if (import.meta.main) {
  process.exitCode = main();
}

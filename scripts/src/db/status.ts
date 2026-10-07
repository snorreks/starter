// scripts/src/db/status.ts
//
// Show which migrations have been applied locally, and whether the local
// database exists at all. Read-only.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runWrangler } from '../cloudflare/wrangler.ts';
import { CLIENT_DIR, REPO_ROOT } from '../shared/paths.ts';
import {
  runSupabaseLocalStatus,
  runSupabaseMigration,
  supabaseBin,
} from '../deploy/providers/supabase.ts';
import { resolveTarget } from '../deploy/target.ts';

const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/backend/database/drizzle-d1');

export const main = (args: readonly string[] = []): number => {
  if (process.env.STARTER_BACKEND_PROFILE === 'supabase') {
    if (supabaseBin() === null) {
      process.stderr.write('Pinned Supabase CLI is unavailable; run `bun install`.\n');
      return 1;
    }
    if (args.length === 0) {
      const result = runSupabaseLocalStatus();
      if (result.stdout) {
        process.stdout.write(result.stdout);
      }
      if (result.stderr) {
        process.stderr.write(result.stderr);
      }
      return result.code;
    }
    if (
      args.length !== 2 ||
      args[0] !== '--remote' ||
      !['staging', 'production'].includes(args[1] ?? '')
    ) {
      process.stderr.write('Usage: db status [--remote staging|production]\n');
      return 2;
    }
    const resolved = resolveTarget(args[1] as 'staging' | 'production', { profile: 'supabase' });
    if (!resolved.ok) {
      process.stderr.write(`${resolved.reason}\n${resolved.remedy}\n`);
      return 1;
    }
    if (!process.env.SUPABASE_ACCESS_TOKEN) {
      process.stderr.write(
        'SUPABASE_ACCESS_TOKEN is required for remote read-only migration status.\n',
      );
      return 1;
    }
    const result = runSupabaseMigration(resolved.target, 'list');
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    return result.code;
  }
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
    join(CLIENT_DIR, 'wrangler.jsonc'),
  ]);
};

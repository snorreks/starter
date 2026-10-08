import {
  runSupabaseLocalStatus,
  runSupabaseMigration,
  supabaseBin,
} from '../deploy/providers/supabase.ts';
import { resolveTarget } from '../deploy/target.ts';
import { resolveBackendProfile } from '../shared/backend_profile.ts';
import { CLIENT_DIR, REPO_ROOT } from '../shared/paths.ts';

export const main = (args: readonly string[] = []): number => {
  if (
    args.length !== 0 &&
    (args.length !== 2 ||
      args[0] !== '--remote' ||
      !['staging', 'production'].includes(args[1] ?? ''))
  ) {
    process.stderr.write('Usage: bun run db:status [--remote staging|production]\n');
    return 2;
  }
  if (supabaseBin() === null) {
    process.stderr.write('Pinned Supabase CLI is unavailable; run `bun install`.\n');
    return 1;
  }
  const remote = args.length === 2 ? (args[1] as 'staging' | 'production') : null;
  if (remote === null) {
    const result = runSupabaseLocalStatus();
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    return result.code;
  }
  const resolved = resolveTarget(remote);
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
};

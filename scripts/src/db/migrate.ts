import { isDeploymentEnvironment } from '@starter/schemas';
import {
  runSupabaseLocalMigration,
  runSupabaseMigration,
  supabaseBin,
  supabaseLocalMigrationArgs,
  supabaseMigrationArgs,
} from '../deploy/providers/supabase.ts';
import { type ResolvedTarget, resolveTarget } from '../deploy/target.ts';
import { EXIT } from '../shared/command.ts';
import { REPO_ROOT } from '../shared/paths.ts';

export { REPO_ROOT };
export type MigrateTarget = 'local' | 'staging' | 'production';

export const parseTarget = (args: readonly string[]): MigrateTarget | null => {
  const remoteIndex = args.indexOf('--remote');
  if (remoteIndex === -1) {
    return args.includes('--local') ? 'local' : 'local';
  }
  if (args.includes('--local')) {
    return null;
  }
  const value = args[remoteIndex + 1];
  return value !== undefined && isDeploymentEnvironment(value) && value !== 'local' ? value : null;
};

export type Plan =
  | { ok: true; target: MigrateTarget; args: string[] }
  | { ok: false; reason: string; remedy: string };

export const planMigrate = (target: MigrateTarget, resolvedTarget?: ResolvedTarget): Plan => {
  if (target === 'local') {
    return { ok: true, target, args: supabaseLocalMigrationArgs() };
  }
  const resolved =
    resolvedTarget === undefined
      ? resolveTarget(target)
      : { ok: true as const, target: resolvedTarget };
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason, remedy: resolved.remedy };
  }
  return { ok: true, target, args: supabaseMigrationArgs(resolved.target, 'push') };
};

export const main = (args: readonly string[]): number => {
  const target = parseTarget(args);
  if (
    target === null ||
    args.some((arg) => !['--local', '--remote', target, '--dry-run', '--yes'].includes(arg))
  ) {
    process.stderr.write('Specify `--local`, or `--remote <staging|production>`.\n');
    return EXIT.usage;
  }
  const resolved = target === 'local' ? undefined : resolveTarget(target);
  if (resolved !== undefined && !resolved.ok) {
    process.stderr.write(`${resolved.reason}\n${resolved.remedy}\n`);
    return EXIT.failed;
  }
  const plan = planMigrate(target, resolved?.ok ? resolved.target : undefined);
  if (!plan.ok) {
    process.stderr.write(`${plan.reason}\n${plan.remedy}\n`);
    return EXIT.failed;
  }
  if (args.includes('--dry-run')) {
    process.stdout.write(`would run: supabase ${plan.args.join(' ')}\n`);
    return EXIT.ok;
  }
  if (supabaseBin() === null) {
    process.stderr.write('Pinned Supabase CLI is unavailable; run `bun install`.\n');
    return EXIT.failed;
  }
  if (target !== 'local' && !args.includes('--yes')) {
    process.stderr.write(`Refusing to migrate Supabase environment ${target} without --yes.\n`);
    return EXIT.usage;
  }
  if (target !== 'local' && !process.env.SUPABASE_ACCESS_TOKEN) {
    process.stderr.write(
      'SUPABASE_ACCESS_TOKEN is required for remote migration and is never passed on argv.\n',
    );
    return EXIT.failed;
  }
  const result =
    target === 'local'
      ? runSupabaseLocalMigration()
      : runSupabaseMigration((resolved as { ok: true; target: ResolvedTarget }).target, 'push');
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  return result.code;
};

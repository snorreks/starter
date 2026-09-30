// scripts/src/lib/db/migrate.ts
//
// Apply Drizzle migrations to D1.
//
//   bun run db:migrate          -> local (wrangler's local state)
//   bun run db:migrate:remote   -> the remote database for the current env
//
// Local and remote are separate commands, not separate flags on one code path,
// because "apply migrations" is the single most consequential thing a developer
// can do to someone else's data. Making the destination a separate invocation
// means the local case cannot grow a `--remote` by accident.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEPLOYMENT_CONFIG, isDeploymentEnvironment } from '@starter/schemas';
import { wranglerAvailable } from '../cloudflare/wrangler.ts';

export const REPO_ROOT = new URL('../../../..', import.meta.url).pathname.replace(/\/$/, '');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/backend/database/drizzle-d1');
const API_DIR = join(REPO_ROOT, 'apps/backend/api');

export type MigrateTarget = 'local' | 'staging' | 'production';

export const parseTarget = (args: readonly string[]): MigrateTarget | null => {
  const hasLocal = args.includes('--local');
  const remoteIndex = args.indexOf('--remote');
  const remote = remoteIndex === -1 ? undefined : args[remoteIndex + 1];

  if (hasLocal && remote !== undefined) {
    return null;
  }
  if (remote === undefined) {
    return 'local';
  }
  return isDeploymentEnvironment(remote) ? remote : null;
};

export type Plan =
  | { ok: true; target: MigrateTarget; command: string; args: string[] }
  | { ok: false; reason: string; remedy: string };

/**
 * Decide what would run, without running it.
 *
 * Separated from execution so `--dry-run` and the test suite can assert on the
 * exact command, and so a missing prerequisite is reported before a mutation.
 */
export const planMigrate = (target: MigrateTarget): Plan => {
  if (!existsSync(MIGRATIONS_DIR)) {
    return {
      ok: false,
      reason: `No migrations found at ${MIGRATIONS_DIR}.`,
      remedy: 'Run `bun run db:generate` to create them from the Drizzle schema.',
    };
  }

  if (target === 'local') {
    return {
      ok: true,
      target,
      command: 'bunx',
      args: ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', join(API_DIR, 'wrangler.jsonc')],
    };
  }

  if (DEPLOYMENT_CONFIG.d1DatabaseIds.api === null) {
    return {
      ok: false,
      reason: 'No D1 database id is configured, so there is no safe target to migrate.',
      remedy:
        `Run \`bun run deploy:configure -- --provision\` to create the database, ` +
        'then re-run. Nothing has been changed.',
    };
  }

  return {
    ok: true,
    target,
    command: 'bunx',
    args: [
      'wrangler',
      'd1',
      'migrations',
      'apply',
      'DB',
      '--remote',
      '--env',
      target,
      '--config',
      join(API_DIR, 'wrangler.jsonc'),
    ],
  };
};

export const main = (args: readonly string[]): number => {
  const target = parseTarget(args);
  if (target === null) {
    process.stderr.write('Specify exactly one target: --local, or --remote <staging|production>.\n');
    return 2;
  }

  if (!wranglerAvailable()) {
    process.stderr.write('wrangler is not available. Run `bun install` first.\n');
    return 1;
  }

  const plan = planMigrate(target);
  if (!plan.ok) {
    process.stderr.write(`${plan.reason}\n  ${plan.remedy}\n`);
    return 1;
  }

  if (args.includes('--dry-run')) {
    process.stdout.write(`would run: ${plan.command} ${plan.args.join(' ')}\n`);
    return 0;
  }

  if (target !== 'local' && !args.includes('--yes')) {
    process.stderr.write(
      `Refusing to migrate ${target} without confirmation.\n` +
        'Re-run with --yes if you are certain, or use --dry-run to see the command.\n',
    );
    return 2;
  }

  const result = spawnSync(plan.command, plan.args, { stdio: 'inherit', cwd: REPO_ROOT });
  return result.status ?? 1;
};

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}

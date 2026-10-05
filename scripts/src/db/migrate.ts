// scripts/src/db/migrate.ts
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

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isDeploymentEnvironment } from '@starter/schemas';
import { runWrangler, wranglerAvailable } from '../cloudflare/wrangler.ts';
import { writeRemoteConfig } from '../deploy/remote_config.ts';
import { resolveTarget } from '../deploy/target.ts';
import { targetsFor } from '../registry/deployment_values.ts';
import { CLIENT_DIR, REPO_ROOT } from '../shared/paths.ts';

const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/backend/database/drizzle-d1');

export { REPO_ROOT };

export type MigrateTarget = 'local' | 'staging' | 'production';

export const parseTarget = (args: readonly string[]): MigrateTarget | null => {
  const hasLocal = args.includes('--local');
  const remoteIndex = args.indexOf('--remote');

  if (remoteIndex === -1) {
    // No --remote at all: local, which is the safe destination. `--local` and no
    // flag are the same request, so there is nothing to reconcile.
    return 'local';
  }

  const remote = args[remoteIndex + 1];

  // `--remote` with no value is a mistake. Previously this fell through to the
  // "no --remote" branch and migrated *local*, so a typo'd invocation quietly did
  // something other than what was asked — the opposite of what a mutating
  // command should do with an unrecognised argument.
  if (remote === undefined || remote.startsWith('-')) {
    return null;
  }

  if (hasLocal) {
    return null;
  }

  // `--remote local` is a contradiction, not a synonym for `--local`.
  if (remote === 'local') {
    return null;
  }

  return isDeploymentEnvironment(remote) ? remote : null;
};

export type Plan =
  | { ok: true; target: MigrateTarget; args: string[] }
  | { ok: false; reason: string; remedy: string };

/**
 * Decide what would run, without running it.
 *
 * Separated from execution so `--dry-run` and the test suite can assert on the
 * exact arguments, and so a missing prerequisite is reported before a mutation.
 *
 * `options.databaseId` lets a caller supply a destination it has already validated
 * through `resolveTarget`. It exists because of a real divergence: this function
 * resolved the database itself, so a caller holding a *validated* target could still
 * have this one silently disagree — and the pipeline would then migrate one database
 * while deploying to another. Passing the validated id in makes the migration
 * destination and the deploy destination the same value by construction.
 * `bun run db:migrate` keeps working on its own.
 *
 * `args` are wrangler subcommand arguments only. The binary is supplied by
 * `runWrangler`, which resolves the pinned workspace copy; naming an executable
 * here is how `bunx` ended up running an unpinned wrangler fetched from npm.
 */
export const planMigrate = (target: MigrateTarget, options: { databaseId?: string } = {}): Plan => {
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
      args: [
        'd1',
        'migrations',
        'apply',
        'DB',
        '--local',
        '--config',
        join(CLIENT_DIR, 'wrangler.jsonc'),
      ],
    };
  }

  const targets = targetsFor(target);
  const databaseId = options.databaseId ?? targets?.d1DatabaseId ?? null;
  if (targets === null || databaseId === null) {
    return {
      ok: false,
      reason: 'No D1 database id is configured, so there is no safe target to migrate.',
      remedy:
        `Run \`bun run deploy:configure -- --env ${target} --provision\` to create the database, ` +
        'then re-run. Nothing has been changed.',
    };
  }

  return {
    ok: true,
    target,
    args: [
      'd1',
      'migrations',
      'apply',
      'DB',
      '--remote',
      '--config',
      join(REPO_ROOT, '.starter/deploy', `${target}-web.json`),
    ],
  };
};

export const main = (args: readonly string[]): number => {
  const target = parseTarget(args);
  if (target === null) {
    process.stderr.write(
      'Specify exactly one target: --local, or --remote <staging|production>.\n',
    );
    return 2;
  }

  const resolved = target === 'local' ? undefined : resolveTarget(target);
  if (resolved !== undefined && !resolved.ok) {
    process.stderr.write(`${resolved.reason}\n${resolved.remedy}\n`);
    return 1;
  }
  const plan = planMigrate(
    target,
    resolved?.ok ? { databaseId: resolved.target.d1DatabaseId } : {},
  );
  if (!plan.ok) {
    process.stderr.write(`${plan.reason}\n  ${plan.remedy}\n`);
    return 1;
  }

  if (!wranglerAvailable()) {
    process.stderr.write('wrangler is not available. Run `bun install` first.\n');
    return 1;
  }

  if (args.includes('--dry-run')) {
    process.stdout.write(`would run: wrangler ${plan.args.join(' ')}\n`);
    return 0;
  }

  if (target !== 'local' && !args.includes('--yes')) {
    process.stderr.write(
      `Refusing to migrate ${target} without confirmation.\n` +
        'Re-run with --yes if you are certain, or use --dry-run to see the command.\n',
    );
    return 2;
  }

  if (resolved?.ok) {
    writeRemoteConfig({ target: resolved.target });
  }
  return runWrangler(plan.args, { cwd: REPO_ROOT });
};

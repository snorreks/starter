// scripts/src/db/migrate.test.ts
//
// Migration planning, with nothing migrated.
//
// Applying a migration is the most consequential thing in this repository: it
// changes the shape of somebody's data, and it is the one operation that cannot
// be undone by rolling back a deploy. The tests below are about what the command
// refuses and what it would run, because those are the two ways it can go wrong
// without anyone noticing until afterwards.
//
// Nothing here executes anything. `planMigrate` is separated from `main` for
// exactly this reason.

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MigrateTarget, parseTarget, planMigrate } from '../src/db/migrate.ts';
import { targets } from '../src/registry/app_registry.ts';
import { resolveDeploymentValues, setDeploymentValues } from '../src/registry/deployment_values.ts';

const root = mkdtempSync(join(tmpdir(), 'starter-migrate-'));
const baseline = resolveDeploymentValues({}, root);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/**
 * Install a database id for the duration of a test.
 *
 * Through the resolver seam, not by mutating the committed `DEPLOYMENT_CONFIG`.
 * `planMigrate` reads `targetsFor`, which reads the *resolved* values; writing to
 * the module production does not read is how a migration test passes while the
 * command refuses.
 */
const setDatabaseId = (value: string | null): void => {
  setDeploymentValues({
    ...baseline,
    accountId: 'a'.repeat(32),
    environments: {
      staging: {
        ...targets(),
        workerName: 'migration-staging',
        origin: 'https://staging.example',
        mailFrom: 'no-reply@staging.example',
        jobsProfile: 'disabled',
        d1DatabaseId: value,
      },
      production: {
        ...targets(),
        workerName: 'migration-production',
        origin: 'https://production.example',
        mailFrom: 'no-reply@production.example',
        jobsProfile: 'disabled',
        d1DatabaseId: value === null ? null : `${value}-production`,
      },
    },
  });
};

beforeEach(() => setDatabaseId(null));
afterEach(() => setDeploymentValues(null));

/**
 * The argv as it will be handed to the wrangler wrapper.
 *
 * `planMigrate` no longer names an executable. The binary is supplied by
 * `runWrangler`, which resolves the pinned workspace copy — naming it here is how
 * `bunx wrangler` came to be used and a different wrangler version from npm ran.
 */
const commandFor = (target: MigrateTarget) => {
  const plan = planMigrate(target);
  if (!plan.ok) {
    throw new Error(`expected a plan, got refusal: ${plan.reason}`);
  }
  return `wrangler ${plan.args.join(' ')}`;
};

describe('parseTarget', () => {
  test('defaults to local', () => {
    // The safe destination. Every consequential action defaults local.
    expect(parseTarget([])).toBe('local');
  });

  test('reads an explicit --local', () => {
    expect(parseTarget(['--local'])).toBe('local');
  });

  test('reads a remote environment', () => {
    expect(parseTarget(['--remote', 'staging'])).toBe('staging');
    expect(parseTarget(['--remote', 'production'])).toBe('production');
  });

  test('refuses --local and --remote together', () => {
    // Two destinations is not a request for either. Picking one silently would
    // mean `bun run db:migrate --local --remote` could migrate production.
    expect(parseTarget(['--local', '--remote', 'production'])).toBeNull();
  });

  test('refuses --remote with no value', () => {
    expect(parseTarget(['--remote'])).toBeNull();
  });

  test('refuses an unknown environment', () => {
    for (const value of ['prod', 'PRODUCTION', 'qa', 'dev']) {
      expect(parseTarget(['--remote', value])).toBeNull();
    }
  });

  test('refuses --local as the value of --remote', () => {
    // `--remote local` is a contradiction, not a synonym for `--local`.
    expect(parseTarget(['--remote', 'local'])).toBeNull();
  });

  test('refuses when the value is another flag', () => {
    expect(parseTarget(['--remote', '--local'])).toBeNull();
  });
});

describe('planMigrate', () => {
  test('a local migration needs no database id', () => {
    setDatabaseId(null);

    expect(planMigrate('local').ok).toBe(true);
  });

  test('a remote migration is refused with no database id', () => {
    setDatabaseId(null);

    // The dangerous case: with no id there is no safe target, and inventing one
    // would migrate a database the user did not choose.
    for (const target of ['staging', 'production'] as const) {
      const plan = planMigrate(target);
      expect(plan.ok).toBe(false);
      if (plan.ok) {
        continue;
      }
      expect(plan.reason).toContain('D1 database id');
    }
  });

  test('the refusal states that nothing was changed', () => {
    setDatabaseId(null);

    const plan = planMigrate('production');
    if (plan.ok) {
      throw new Error('expected a refusal');
    }

    // Someone who reads only the error should not wonder whether it half-ran.
    expect(plan.remedy).toContain('Nothing has been changed');
  });

  test('a remote migration is allowed once an id exists', () => {
    setDatabaseId('test-database-id');

    expect(planMigrate('staging').ok).toBe(true);
    expect(planMigrate('production').ok).toBe(true);
  });

  test('the local plan targets local state', () => {
    const command = commandFor('local');

    expect(command).toContain('--local');
    // The remote flag must be absent, not merely accompanied by --local: wrangler
    // treats `--remote` as taking precedence.
    expect(command).not.toContain('--remote');
  });

  test('the local plan carries no environment', () => {
    expect(commandFor('local')).not.toContain('--env');
  });

  test('a remote plan targets remote state', () => {
    setDatabaseId('test-database-id');

    const command = commandFor('production');

    expect(command).toContain('--remote');
    expect(command).not.toContain('--local');
  });

  test('a remote plan names its environment', () => {
    setDatabaseId('test-database-id');

    expect(commandFor('staging')).toContain('.starter/deploy/staging-web.json');
    expect(commandFor('production')).toContain('.starter/deploy/production-web.json');
    expect(commandFor('staging')).not.toContain('--env');
    expect(commandFor('production')).not.toContain('--env');
  });

  test('every plan names the wrangler config of the one application', () => {
    // Without it, wrangler resolves the config from the working directory, and
    // the migrations would apply to whichever database that config names.
    for (const target of ['local', 'staging', 'production'] as const) {
      setDatabaseId('test-database-id');
      expect(commandFor(target)).toContain(
        target === 'local' ? 'wrangler.jsonc' : `.starter/deploy/${target}-web.json`,
      );
    }
  });

  test('the plan records the target it was given', () => {
    setDatabaseId('test-database-id');

    for (const target of ['local', 'staging', 'production'] as const) {
      const plan = planMigrate(target);
      if (plan.ok) {
        expect(plan.target).toBe(target);
      }
    }
  });

  test('the plan args never carry the wrangler token', () => {
    // The wrapper supplies the binary. A duplicate here is the process that ran
    // `wrangler wrangler d1 migrations apply`.
    setDatabaseId('test-database-id');

    for (const target of ['local', 'staging', 'production'] as const) {
      const plan = planMigrate(target);
      expect(plan.ok).toBe(true);
      if (!plan.ok) {
        continue;
      }
      expect(plan.args.filter((arg) => arg === 'wrangler')).toHaveLength(0);
      expect(plan.args[0]).toBe('d1');
    }
  });
});

describe('planMigrate: what it will never do', () => {
  test('never targets a database name other than the configured binding', () => {
    // `DB` is the binding name from wrangler.jsonc. A literal database id in the
    // command would be a resource name that no longer matches the config.
    setDatabaseId('test-database-id');

    for (const target of ['local', 'staging', 'production'] as const) {
      const command = commandFor(target);
      expect(command).toContain('migrations apply DB');
      expect(command).not.toContain('test-database-id');
    }
  });

  test('never drops or deletes anything', () => {
    setDatabaseId('test-database-id');

    for (const target of ['local', 'staging', 'production'] as const) {
      const command = commandFor(target);
      expect(command).not.toContain('drop');
      expect(command).not.toContain('delete');
      expect(command).not.toContain('rm ');
      expect(command).not.toContain('--force');
    }
  });

  test('never seeds data, which is a separate deliberate act', () => {
    setDatabaseId('test-database-id');

    for (const target of ['local', 'staging', 'production'] as const) {
      expect(commandFor(target)).not.toContain('seed');
    }
  });
});

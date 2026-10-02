// scripts/tests/deployment_cli.test.ts
//
// The argument surface, and the plan it produces.
//
// Replaces a pair of files that tested the same phase through a different shape.
// What is worth keeping is narrow and specific: every token accounted for, a typo
// never widened into a wider blast radius, and a plan that renders the same argv it
// would execute.
//
// The old suite had a `targets` concept — `web`, `api` — that no longer exists.
// There is one Worker, so there is one thing to name, and a target word that
// silently defaulted to "everything" is the behaviour these tests exist to prevent.

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEPLOY_PHASES, parseDeployArgs, planDeploy, renderPlan } from '../src/deploy/deploy.ts';
import type { DeploymentValues } from '../src/registry/deployment_values.ts';

const ACCOUNT = 'abcdef0123456789abcdef0123456789';

const configured = (): DeploymentValues => ({
  accountId: ACCOUNT,
  workerName: null,
  d1DatabaseId: null,
  r2BucketNames: { uploads: null },
  customDomain: null,
  environments: {
    staging: {
      workerName: 'starter-staging',
      d1DatabaseId: 'db-staging',
      origin: 'https://starter-staging.example',
    },
    production: {
      workerName: 'starter-production',
      d1DatabaseId: 'db-production',
      origin: 'https://starter.example',
    },
  },
});

describe('every token in argv must be accounted for', () => {
  test('no arguments means apply, with no environment yet', () => {
    const parsed = parseDeployArgs([]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    // Defaulting to `apply` preserves `bun run deploy -- --env staging --yes`,
    // which is what an operator types expecting a deploy.
    expect(parsed.phase).toBe('apply');
    expect(parsed.environment).toBeNull();
    expect(parsed.yes).toBe(false);
  });

  test('each phase is recognised', () => {
    for (const phase of DEPLOY_PHASES) {
      const parsed = parseDeployArgs([phase]);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) {
        continue;
      }
      expect(parsed.phase).toBe(phase);
    }
  });

  test('an unknown phase is an error naming the valid ones', () => {
    // `web` used to be a target word. It is gone, and the message says so — a
    // silent fallback here would deploy to whichever thing matched first.
    const parsed = parseDeployArgs(['webb']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors[0]).toContain('Unknown phase "webb"');
    expect(parsed.errors[0]).toContain('apply');
  });

  test('the removed target word explains its replacement', () => {
    const parsed = parseDeployArgs(['web', '--env', 'staging']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors[0]).toContain('bun run deploy apply');
  });

  test('two phases are a conflict, not a silent last-one-wins', () => {
    const parsed = parseDeployArgs(['plan', 'apply']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors[0]).toContain('Conflicting phases');
  });

  test('the same phase twice is harmless', () => {
    const parsed = parseDeployArgs(['plan', 'plan']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.phase).toBe('plan');
  });

  test.each([['prod'], ['Production'], ['stage'], ['local']])(
    '`--env %s` is refused rather than resolved to a nearby value',
    (value) => {
      const parsed = parseDeployArgs(['plan', '--env', value]);
      expect(parsed.ok).toBe(false);
    },
  );

  test('`--env local` explains that local is a runtime', () => {
    const parsed = parseDeployArgs(['apply', '--env', 'local']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors[0]).toContain('bun run dev');
  });

  test('two different `--env` values are a conflict', () => {
    const parsed = parseDeployArgs(['plan', '--env', 'staging', '--env', 'production']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors[0]).toContain('Conflicting --env');
  });

  test('the same `--env` twice is harmless', () => {
    const parsed = parseDeployArgs(['plan', '--env', 'staging', '--env', 'staging']);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.environment).toBe('staging');
  });

  test('an unknown flag is an error, not a silent no-op', () => {
    const parsed = parseDeployArgs(['plan', '--verbose']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors[0]).toContain('Unknown flag "--verbose"');
  });

  test.each([['--yes=false'], ['--dry-run=true']])(
    '%s is refused: these are flags, not key=value pairs',
    (token) => {
      // Matching against the whole token rather than splitting first is the fix.
      // Splitting meant `--dry-run=false` set `dryRun = true` — the opposite of what
      // was written — while `--yes=false` granted the consent it appears to refuse.
      const parsed = parseDeployArgs(['apply', token]);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) {
        return;
      }
      expect(parsed.errors[0]).toContain('is a flag, not a key=value pair');
    },
  );

  test('`--env=staging` is refused with the form that works', () => {
    const parsed = parseDeployArgs(['plan', '--env=staging']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors[0]).toContain('--env staging');
  });

  test('`--env` with no value is an error', () => {
    const parsed = parseDeployArgs(['plan', '--env']);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) {
      return;
    }
    expect(parsed.errors[0]).toContain('--env needs a value');
  });

  test('consent and the migration and first-deploy flags are read as booleans', () => {
    const parsed = parseDeployArgs([
      'apply',
      '--env',
      'staging',
      '--yes',
      '--skip-migrations',
      '--allow-new-worker',
      '--json',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.yes).toBe(true);
    expect(parsed.skipMigrations).toBe(true);
    expect(parsed.allowNewWorker).toBe(true);
    expect(parsed.json).toBe(true);
  });
});

/**
 * A throwaway tree whose `wrangler.jsonc` names the same database the plan resolves.
 *
 * The plan refuses when the id it resolved and the id Wrangler would reach differ,
 * which is the check that catches a migration and a deploy aimed at two different
 * databases. Testing against the repository's own config would make that assertion
 * depend on whatever anyone last provisioned; a fixture keeps it a statement about
 * the plan.
 */
const fixtureRoot = (databaseId: string): string => {
  const root = mkdtempSync(join(tmpdir(), 'starter-plan-'));
  const path = join(root, 'apps/frontend/client/wrangler.jsonc');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `{\n  "name": "starter",\n  "d1_databases": [\n    {\n      "binding": "DB",\n      "database_name": "starter",\n      "database_id": "${databaseId}"\n    }\n  ]\n}\n`,
    'utf8',
  );
  return root;
};

describe('the offline plan names one destination and the commands for it', () => {
  test('staging and production produce different plans', () => {
    // The property that makes `--env` mean something. With one set of names both
    // plans were identical and the flag changed a notice and nothing else.
    const staging = planDeploy('staging', {
      values: configured(),
      hasCredential: false,
      root: fixtureRoot('db-staging'),
    });
    const production = planDeploy('production', {
      values: configured(),
      hasCredential: false,
      root: fixtureRoot('db-production'),
    });

    expect(staging.ok && production.ok).toBe(true);
    if (!staging.ok || !production.ok) {
      return;
    }

    expect(staging.target.workerName).toBe('starter-staging');
    expect(production.target.workerName).toBe('starter-production');
    expect(renderPlan(staging)).not.toBe(renderPlan(production));
  });

  test('the rendered argv is the argv that would be spawned', () => {
    const plan = planDeploy('staging', {
      values: configured(),
      hasCredential: false,
      root: fixtureRoot('db-staging'),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }

    const rendered = renderPlan(plan);
    for (const step of plan.steps) {
      expect(rendered).toContain(`${step.command} ${step.args.join(' ')}`);
    }

    // No secret is ever in the plan: the required secrets appear as names, and the
    // plan is what gets pasted into a ticket.
    expect(rendered).toContain('BETTER_AUTH_SECRET, RESEND_API_KEY');
    expect(rendered).not.toMatch(/secret\s*[:=]\s*[A-Za-z0-9]{8,}/i);
  });

  test('the plan is answerable with no credential', () => {
    // This is what lets `plan` run on a fork's pull request, where no secret exists.
    const plan = planDeploy('staging', {
      values: configured(),
      hasCredential: false,
      root: fixtureRoot('db-staging'),
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(renderPlan(plan)).toContain('cannot be executed here');
  });

  test('an unprovisioned project is refused, with the command that fixes it', () => {
    const empty: DeploymentValues = {
      accountId: null,
      workerName: null,
      d1DatabaseId: null,
      r2BucketNames: { uploads: null },
      customDomain: null,
    };
    const plan = planDeploy('staging', { values: empty });

    expect(plan.ok).toBe(false);
    if (plan.ok) {
      return;
    }
    expect(plan.reason).toContain('No Cloudflare account id is configured');
    expect(plan.remedy).toContain('deploy:configure');
  });

  test('the migration step comes before the deploy step', () => {
    // The order is the design: the new code must never meet the old schema.
    const plan = planDeploy('staging', { values: configured(), root: fixtureRoot('db-staging') });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }

    const descriptions = plan.steps.map((step) => step.description).join(' ');
    expect(descriptions.indexOf('migrations')).toBeLessThan(descriptions.indexOf('Deploy'));
    expect(descriptions).toContain('/health');
  });

  test('the plan warns that a code rollback is not a schema rollback', () => {
    const plan = planDeploy('staging', { values: configured(), root: fixtureRoot('db-staging') });
    expect(plan.ok).toBe(true);
    if (!plan.ok) {
      return;
    }
    expect(plan.notices.join(' ')).toContain('does not roll back the schema');
  });
});

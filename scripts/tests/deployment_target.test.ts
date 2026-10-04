// scripts/tests/deployment_target.test.ts
//
// The refusals, before anything is touched.
//
// Every case here is a state the template reaches constantly — an unprovisioned
// checkout, a typo in `--env`, a staging database copied into production — and the
// thing being asserted is always the same: `resolveTarget` refuses, and it says
// what to do instead. A refusal that returns `null` or throws a bare `TypeError` is
// not a refusal an operator can act on.

import { describe, expect, test } from 'bun:test';
import {
  describeCredential,
  hasApiToken,
  SUPPORTED_CREDENTIAL_MODES,
  secretInArgvProblem,
} from '../src/deploy/credentials.ts';
import { preflight } from '../src/deploy/preflight.ts';
import {
  DEPLOYABLE_ENVIRONMENTS,
  environmentIsolationProblem,
  type ResolvedTarget,
  resolveTarget,
} from '../src/deploy/target.ts';
import { targets } from '../src/registry/app_registry.ts';
import type { DeploymentValues } from '../src/registry/deployment_values.ts';

const ACCOUNT = 'abcdef0123456789abcdef0123456789';
const OTHER_ACCOUNT = '99999999999999999999999999999999';

/** A project with both environments fully provisioned and properly separated. */
const configured = (overrides: Partial<DeploymentValues> = {}): DeploymentValues => ({
  accountId: ACCOUNT,
  workerName: null,
  d1DatabaseId: null,
  r2BucketNames: { uploads: null },
  customDomain: null,
  jobsProfile: 'disabled',
  environments: {
    staging: targets({
      workerName: 'starter-staging',
      d1DatabaseId: 'db-staging',
      origin: 'https://starter-staging.example.workers.dev',
      mailFrom: 'noreply@starter.example',
      jobsProfile: 'disabled',
    }),
    production: targets({
      workerName: 'starter-production',
      d1DatabaseId: 'db-production',
      origin: 'https://starter.example',
      mailFrom: 'noreply@starter.example',
      jobsProfile: 'disabled',
    }),
  },
  ...overrides,
});

const resolved = (environment: string, values = configured()): ResolvedTarget => {
  const result = resolveTarget(environment, { values });
  if (!result.ok) {
    throw new Error(`Expected ${environment} to resolve, got: ${result.reason}`);
  }
  return result.target;
};

describe('resolveTarget answers with one complete destination', () => {
  test('every value a deploy touches comes from the same resolution', () => {
    // The point of the module. A plan built from one source and executed against
    // another is the failure this whole layer exists to make impossible, so the
    // assertion is that one call yields all of it consistently.
    const target = resolved('staging');

    expect(target.environment).toBe('staging');
    expect(target.accountId).toBe(ACCOUNT);
    expect(target.workerName).toBe('starter-staging');
    expect(target.d1DatabaseId).toBe('db-staging');
    expect(target.origin).toBe('https://starter-staging.example.workers.dev');
    expect(target.wranglerConfig).toBe('apps/frontend/client/wrangler.jsonc');
  });

  test('staging and production resolve to genuinely different destinations', () => {
    const staging = resolved('staging');
    const production = resolved('production');

    expect(staging.workerName).not.toBe(production.workerName);
    expect(staging.d1DatabaseId).not.toBe(production.d1DatabaseId);
    expect(staging.origin).not.toBe(production.origin);
  });

  test('required secrets are named, never valued', () => {
    // A plan gets pasted into tickets. What an environment *needs* is public; what
    // it is is not.
    const target = resolved('production');
    expect(target.requiredSecretNames).toEqual(['BETTER_AUTH_SECRET', 'RESEND_API_KEY']);
    expect(target.requiredVarNames).toContain('DEPLOYMENT_ENV');
    expect(target.requiredVarNames).toContain('RELEASE');
  });
});

describe('resolveTarget refuses before any mutation', () => {
  test('an unknown environment is not resolved to a nearby one', () => {
    // `--env prod` must not reach production. That is the whole reason the parser
    // and this module both validate rather than normalising.
    for (const typo of ['prod', 'Production', 'stage', '', 'localhost']) {
      const result = resolveTarget(typo, { values: configured() });
      expect(result.ok).toBe(false);
      if (result.ok) {
        continue;
      }
      expect(result.reason).toContain('not a deployable environment');
    }
  });

  test('`local` is refused: it is a runtime, not a destination', () => {
    const result = resolveTarget('local', { values: configured() });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.remedy).toContain('bun run dev');
  });

  test('each deployable environment is accepted', () => {
    for (const environment of DEPLOYABLE_ENVIRONMENTS) {
      expect(resolveTarget(environment, { values: configured() }).ok).toBe(true);
    }
  });

  test.each([
    ['accountId', null, 'No Cloudflare account id is configured'],
    ['accountId', 'not-hex', 'not a 32-character hexadecimal'],
  ] as const)('a missing or malformed %s refuses', (key, value, expected) => {
    const result = resolveTarget('staging', { values: configured({ [key]: value }) });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain(expected);
  });

  test.each([
    ['workerName', null, 'No Worker name is configured'],
    ['d1DatabaseId', null, 'No D1 database id is configured'],
    ['origin', null, 'No public origin is configured'],
  ] as const)('a %s of null refuses rather than defaulting', (key, value, expected) => {
    const base = configured();
    const environments = { ...(base.environments ?? {}) };
    const staging = { ...(environments.staging ?? {}) } as Record<string, string | null>;
    staging[key] = value;
    const result = resolveTarget('staging', {
      values: configured({
        environments: { staging, production: environments.production } as never,
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain(expected);
  });

  test('an environment absent from a project that has environments is refused', () => {
    const base = configured();
    const result = resolveTarget('production', {
      values: configured({
        environments: { staging: base.environments?.staging } as never,
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('no topology for the "production" environment');
  });

  test.each([
    ['http://starter.example', 'is not https'],
    ['https://starter.example/notes', 'has a path, query or fragment'],
    ['https://starter.example?a=1', 'has a path, query or fragment'],
    ['not a url', 'is not an absolute URL'],
  ])('an unusable origin (%s) refuses', (origin, expected) => {
    const base = configured();
    const result = resolveTarget('production', {
      values: configured({
        environments: {
          ...base.environments,
          production: {
            workerName: 'starter-production',
            d1DatabaseId: 'db-production',
            origin,
          },
        } as never,
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain(expected);
  });

  test('a Worker name wrangler would accept but nobody meant is refused', () => {
    // `api` is a valid Cloudflare name. That is the problem: the failure it replaced
    // published to the wrong Worker and nothing complained.
    const base = configured();
    const result = resolveTarget('staging', {
      values: configured({
        environments: {
          ...base.environments,
          staging: { workerName: 'api', d1DatabaseId: 'db-staging', origin: null },
        } as never,
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('No public origin is configured');
  });

  test('a Worker name Cloudflare would reject is refused before wrangler sees it', () => {
    const base = configured();
    const result = resolveTarget('staging', {
      values: configured({
        environments: {
          ...base.environments,
          staging: {
            workerName: 'Not A Valid Name',
            d1DatabaseId: 'db-staging',
            origin: 'https://staging.example',
          },
        } as never,
      }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toContain('is not a valid Cloudflare Worker name');
  });
});

describe('staging and production may not share a resource', () => {
  test('a shared Worker name is refused', () => {
    const base = configured();
    const problem = environmentIsolationProblem(
      configured({
        environments: {
          ...base.environments,
          production: {
            workerName: 'starter-staging',
            d1DatabaseId: 'db-production',
            origin: 'https://starter.example',
            mailFrom: 'noreply@starter.example',
            jobsProfile: 'disabled',
          },
        } as never,
      }),
    );

    expect(problem).toContain('both resolve to the Worker');
    expect(problem).toContain('starter-staging');
  });

  test('a shared D1 database is refused, and the message says which pair', () => {
    // The one that matters most: a shared database makes a staging migration a
    // production migration.
    const base = configured();
    const problem = environmentIsolationProblem(
      configured({
        environments: {
          ...base.environments,
          production: {
            workerName: 'starter-production',
            d1DatabaseId: 'db-staging',
            origin: 'https://starter.example',
            mailFrom: 'noreply@starter.example',
            jobsProfile: 'disabled',
          },
        } as never,
      }),
    );

    expect(problem).toContain('both resolve to the D1 database');
    expect(problem).toContain('db-staging');
  });

  test('resolveTarget refuses rather than planning against a shared resource', () => {
    const base = configured();
    const result = resolveTarget('staging', {
      values: configured({
        environments: {
          ...base.environments,
          production: {
            workerName: 'starter-production',
            d1DatabaseId: 'db-staging',
            origin: 'https://starter.example',
            mailFrom: 'noreply@starter.example',
            jobsProfile: 'disabled',
          },
        } as never,
      }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.remedy).toContain('Give each environment its own Worker name and D1 database id');
  });

  test('a properly separated project reports no problem', () => {
    expect(environmentIsolationProblem(configured())).toBeNull();
  });
});

describe('the documented credential modes are the implemented ones', () => {
  test('exactly one mode is supported, and it is the environment variable', () => {
    // The previous tooling claimed two modes while reading one, so an operator who
    // ran `wrangler login` was told "no credential". The list is the contract.
    expect(SUPPORTED_CREDENTIAL_MODES).toEqual(['env-api-token']);
  });

  test('the reported source is the variable name, never the value', () => {
    const state = describeCredential({ CLOUDFLARE_API_TOKEN: 'super-secret-token-value' });

    expect(state.mode).toBe('env-api-token');
    expect(state.source).toBe('CLOUDFLARE_API_TOKEN');
    // The decisive assertion: nothing derived from the secret reaches a report
    // that gets pasted into a ticket.
    expect(JSON.stringify(state)).not.toContain('super-secret-token-value');
  });

  test('`wrangler login` OAuth state is deliberately not a credential', () => {
    // There is no env var for it, so this is the honest assertion available: the
    // mode is absent and the remedy explains why rather than failing opaquely.
    const state = describeCredential({});
    expect(state.mode).toBeNull();
    expect(state.remedy).toContain('wrangler login');
    expect(hasApiToken({})).toBe(false);
  });

  test('whitespace is not a credential', () => {
    expect(hasApiToken({ CLOUDFLARE_API_TOKEN: '   ' })).toBe(false);
  });
});

describe('a secret is never placed in argv', () => {
  test.each([
    // Bare and `=value` spellings of the same flag. The `=` form is one token, so a
    // check for the bare token walks straight past it — and that is the spelling a
    // shell completion produces.
    [['--api-token', 'abc'], 'would place a secret in this process'],
    [['--api-token=abc'], 'would place a secret in this process'],
    [['--token=abc'], 'would place a secret in this process'],
    // Both `--var` spellings.
    [['--var', 'BETTER_AUTH_SECRET:hunter2'], 'BETTER_AUTH_SECRET'],
    [['--var=BETTER_AUTH_SECRET:hunter2'], 'BETTER_AUTH_SECRET'],
    [['--var', 'BETTER_AUTH_SECRET', 'hunter2'], 'BETTER_AUTH_SECRET'],
    // The one a `SECRET` substring misses entirely, and the reason the registry's
    // own list is consulted first.
    [['--var', 'RESEND_API_KEY:re_x'], 'RESEND_API_KEY'],
  ])('refuses %j', (args, expected) => {
    const problem = secretInArgvProblem(args);
    expect(problem).not.toBeNull();
    expect(problem).toContain(expected);
  });

  test('an ordinary non-secret var is allowed through', () => {
    expect(secretInArgvProblem(['--var', 'RELEASE:abc123'])).toBeNull();
    expect(secretInArgvProblem(['--var=RELEASE:abc123'])).toBeNull();
    expect(secretInArgvProblem(['deploy', '--env', 'staging', '--yes'])).toBeNull();
  });
});

describe('a wrong account is refused, naming both accounts', () => {
  test('preflight reports the configured account and the one the credential reaches', () => {
    // The whole point of carrying the account id is being able to name it when it
    // is wrong. The earlier version of this test asserted that the resolved target
    // held a different account — which is a statement about the fixture, not about
    // any refusal.
    const resolved = resolveTarget('staging', {
      values: configured({ accountId: OTHER_ACCOUNT }),
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) {
      throw new Error('fixture did not resolve');
    }

    const report = preflight(resolved.target, {
      env: { CLOUDFLARE_API_TOKEN: 't' },
      run: (args) =>
        args[0] === 'whoami'
          ? { ok: true, stdout: `Account: ${ACCOUNT}\n`, stderr: '' }
          : { ok: true, stdout: `{"account_id":"${ACCOUNT}"}`, stderr: '' },
    });

    expect(report.ok).toBe(false);
    expect(report.findings[0]?.detail).toContain(ACCOUNT);
    expect(report.findings[0]?.detail).toContain(OTHER_ACCOUNT);
  });
});

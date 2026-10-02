// scripts/src/deploy/target.ts
//
// The one authority for "what would this command actually change".
//
// Everything that can reach a remote resource — the plan, the preflight, the
// migrate command, the deploy, the verify, the release record — resolves its
// destination through `resolveTarget` here, and nothing else. That is the whole
// design: a command that answered a different question from the plan the
// operator approved is the failure this module exists to make impossible.
//
// It is deliberately *offline*. It reads configuration and refuses; it never
// spawns a process, never contacts Cloudflare and never decrypts anything. The
// distinction matters because `plan` has to be answerable on a laptop with no
// credential at all, and because a "plan" that quietly authenticated is not a
// plan a reviewer can trust.
//
// Four refusals, each for a way this has previously gone wrong:
//
//   1. **An unknown environment.** `--env prod` is a typo, not a synonym.
//   2. **A missing value.** `null` means "not provisioned". Every deployment
//      resource id in this repository starts `null` on purpose — a template that
//      ships ids points every new user at one account.
//   3. **Two environments sharing a resource.** Staging and production are
//      separate Workers and separate databases. One name or one database id in
//      both is the configuration that a test run quietly promotes to live traffic,
//      and it is refused here, before any mutation, rather than caught afterwards.
//   4. **A non-https or non-absolute origin.** Verification is made against this
//      address; an origin that is not an absolute https URL is not an address.

import type { DeploymentEnvironment } from '@starter/schemas';
import {
  DEPLOYMENT_CONFIG,
  REQUIRED_REMOTE_SECRET_NAMES,
  REQUIRED_REMOTE_VAR_NAMES,
} from '../registry/app_registry.ts';
import {
  type DeploymentValues,
  effectiveDeploymentValues,
  topologyFor,
} from '../registry/deployment_values.ts';
import { CLIENT_DIR_RELATIVE } from '../shared/paths.ts';

/** The environments this project can deploy to. `local` is a runtime, not a target. */
export const DEPLOYABLE_ENVIRONMENTS = ['staging', 'production'] as const;

/**
 * The narrow type a resolved target carries.
 *
 * Not `DeploymentEnvironment`, which also contains `local`. Keeping the two apart
 * is what stops a `local` value reaching `ResolvedTarget` through a cast that
 * compiled: the whole point of the `local` refusal is that it is not a target.
 */
export type TargetEnvironment = (typeof DEPLOYABLE_ENVIRONMENTS)[number];

export interface ResolvedTarget {
  environment: TargetEnvironment;
  /** Project identity, from the committed registry. Never a secret. */
  project: string;
  accountId: string;
  workerName: string;
  d1DatabaseId: string;
  /** Absolute https origin verification is made against. */
  origin: string;
  /** Canonical Wrangler input. Bindings and generated types are read from this. */
  wranglerConfig: string;
  /** Secret *names* required, in documented apply order. Never values. */
  requiredSecretNames: readonly string[];
  /** Nonsecret var names required. Never values. */
  requiredVarNames: readonly string[];
}

export interface TargetFailure {
  ok: false;
  reason: string;
  remedy: string;
}
export type TargetResult = { ok: true; target: ResolvedTarget } | TargetFailure;

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

/**
 * A Worker name Cloudflare will actually accept.
 *
 * Checked here rather than left to wrangler because the failure mode of not
 * checking is not a rejected deploy: `wrangler deploy --name api` succeeds and
 * publishes to a Worker called `api`. A name that satisfies this pattern cannot
 * silently become a different resource.
 */
const WORKER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const fail = (reason: string, remedy: string): TargetFailure => ({ ok: false, reason, remedy });

/**
 * An absolute `https://` origin with no path, query or fragment.
 *
 * Rejecting the extras is not pedantry: the origin is used both as the base URL
 * Better Auth issues cookies for and as the address verification fetches. A
 * trailing path would make `/api/health` resolve somewhere the operator did not
 * intend, and the mismatch would only show up as a confusing verification
 * failure after the deploy succeeded.
 */
const parseOrigin = (
  value: string,
): { ok: true; origin: string } | { ok: false; problem: string } => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, problem: `"${value}" is not an absolute URL` };
  }

  if (url.protocol !== 'https:') {
    return { ok: false, problem: `"${value}" is not https` };
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    return {
      ok: false,
      problem: `"${value}" has a path, query or fragment`,
    };
  }

  return { ok: true, origin: url.origin };
};

/**
 * Refuse two environments that would resolve to the same Worker or database.
 *
 * The check is over the *resolved* topology rather than the raw map, which is what
 * makes it catch the case that matters. A project with no `environments` map has one
 * set of names, so `--env staging` and `--env production` resolve to the same Worker
 * and the same database — and a production release would then be a staging release.
 * Comparing map entries alone cannot see that: there are no entries to compare.
 *
 * Refused here, before any mutation, and reported against the *resolved* values, so
 * the message names the resource that is actually shared rather than a key in a
 * file.
 *
 * Returns `null` when every deployable environment resolves to its own resources.
 */
export const environmentIsolationProblem = (
  values: DeploymentValues = effectiveDeploymentValues(),
): string | null => {
  const resolved = new Map<string, { worker: string | null; database: string | null }>();

  for (const environment of DEPLOYABLE_ENVIRONMENTS) {
    const topology = topologyFor(environment, values);
    resolved.set(environment, {
      worker: topology?.workerName ?? null,
      database: topology?.d1DatabaseId ?? null,
    });
  }

  const entries = [...resolved.entries()].filter(
    ([, value]) => value.worker !== null || value.database !== null,
  );

  for (const [environment, value] of entries) {
    for (const [other, otherValue] of entries) {
      if (environment >= other) {
        continue;
      }

      if (value.worker !== null && value.worker === otherValue.worker) {
        return (
          `${environment} and ${other} both resolve to the Worker "${value.worker}". A Worker is ` +
          'one resource per account, so the two environments are the same deployment.'
        );
      }

      if (value.database !== null && value.database === otherValue.database) {
        return (
          `${environment} and ${other} both resolve to the D1 database ${value.database}. A shared ` +
          'database means a staging migration is a production migration.'
        );
      }
    }
  }

  return null;
};

/**
 * Resolve and fully validate the destination for one environment.
 *
 * Pure and offline. Every input is a parameter, so the whole authority is
 * reachable from a test without a repository, a credential or a network.
 */
export const resolveTarget = (
  environment: string,
  options: {
    values?: DeploymentValues;
    project?: string;
    requiredSecretNames?: readonly string[];
  } = {},
): TargetResult => {
  const values = options.values ?? effectiveDeploymentValues();

  // Refused before any other work, so an unknown word can never be resolved
  // against a default. `--env prod` must not reach the production entry it
  // resembles, and `--env local` must not reach anything at all: `local` is a
  // *runtime* (`bun run dev`), not a place a Worker can be deployed to.
  if (!(DEPLOYABLE_ENVIRONMENTS as readonly string[]).includes(environment)) {
    return fail(
      `"${environment}" is not a deployable environment.`,
      `Environments: ${DEPLOYABLE_ENVIRONMENTS.join(', ')}. ` +
        '`local` is a runtime (`bun run dev`), not a deployment target.',
    );
  }

  const isolated = environmentIsolationProblem(values);
  if (isolated !== null) {
    return fail(
      isolated,
      'Give each environment its own Worker name and D1 database id. This is refused ' +
        'before anything is changed, because the alternative is a staging release ' +
        'reaching live traffic.\n' +
        '  bun run deploy:configure -- --env staging --worker <name>\n' +
        '  bun run deploy:configure -- --env production --worker <name>',
    );
  }

  const accountId = values.accountId;
  if (accountId === null) {
    return fail(
      'No Cloudflare account id is configured.',
      'bun run deploy:configure -- --account <32-hex>\n' +
        '  (recorded in the gitignored overlay; it is configuration, not a secret)',
    );
  }
  if (!ACCOUNT_ID.test(accountId)) {
    return fail(
      `"${accountId}" is not a 32-character hexadecimal Cloudflare account id.`,
      'Find it at https://dash.cloudflare.com → Workers & Pages → Account ID.',
    );
  }

  const topology = topologyFor(environment as DeploymentEnvironment, values);
  if (topology === null) {
    return fail(
      `This project has no topology for the "${environment}" environment.`,
      `Add an "environments.${environment}" entry to the deployment overlay, or remove ` +
        'the "environments" object entirely if the project genuinely has one environment. ' +
        'Refusing rather than defaulting: serving a staging request with production ' +
        'names is the worst outcome this layer exists to prevent.',
    );
  }

  const workerName = topology.workerName;
  if (workerName === null) {
    return fail(
      `No Worker name is configured for ${environment}.`,
      `bun run deploy:configure -- --env ${environment} --worker <name>`,
    );
  }
  if (!WORKER_NAME.test(workerName)) {
    return fail(
      `"${workerName}" is not a valid Cloudflare Worker name.`,
      'Lowercase letters, digits and dashes; must start with a letter or digit. A name ' +
        'wrangler rejects fails the deploy; one it *accepts* publishes to a Worker you ' +
        'did not intend, which is why it is checked here.',
    );
  }

  const databaseId = topology.d1DatabaseId;
  if (databaseId === null) {
    return fail(
      `No D1 database id is configured for ${environment}.`,
      `bun run deploy:configure -- --env ${environment} --provision`,
    );
  }

  const rawOrigin = topology.origin;
  if (rawOrigin === null) {
    return fail(
      `No public origin is configured for ${environment}, so a deploy could not be verified.`,
      `bun run deploy:configure -- --env ${environment} --origin https://<host>\n` +
        '  The origin cannot be derived: the workers.dev subdomain belongs to the account, ' +
        'and an operator may serve a custom domain instead.',
    );
  }
  const parsed = parseOrigin(rawOrigin);
  if (!parsed.ok) {
    return fail(
      `The configured origin for ${environment} ${parsed.problem}.`,
      'It must be an absolute https URL with no path, query or fragment: it is the base ' +
        'URL Better Auth issues cookies for and the address verification fetches.',
    );
  }

  return {
    ok: true,
    target: {
      environment: environment as TargetEnvironment,
      project: options.project ?? DEPLOYMENT_CONFIG.projectName,
      accountId: accountId.toLowerCase(),
      workerName,
      d1DatabaseId: databaseId,
      origin: parsed.origin,
      wranglerConfig: `${CLIENT_DIR_RELATIVE}/wrangler.jsonc`,
      requiredSecretNames: options.requiredSecretNames ?? REQUIRED_REMOTE_SECRET_NAMES,
      requiredVarNames: REQUIRED_REMOTE_VAR_NAMES,
    },
  };
};

/**
 * The origin a fresh project would serve on, for display only.
 *
 * Never used as a value: it is a guess, and `resolveTarget` refuses to plan
 * against a guess. It exists so `deploy:configure` can print the shape of what
 * the operator is about to type.
 */
export const suggestOrigin = (workerName: string): string =>
  `https://${workerName}.<account-subdomain>.workers.dev`;

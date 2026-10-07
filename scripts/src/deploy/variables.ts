// scripts/src/deploy/variables.ts
//
// The CI variable layer: how a deployment job learns a *nonsecret* destination
// before any secret exists, and why the obvious configuration does not work.
//
// ── The defect this exists to fix ─────────────────────────────────────────────
//
// `.github/workflows/deploy.yml` gave the `plan` job no `environment:` — on
// purpose, so a plan can be reviewed by someone without deploy authority. But
// GitHub only exposes **environment-scoped** variables and secrets to a job that
// declares that environment. So a project configured the documented way
// ("set the staging variables on the staging environment") has a `plan` job that
// resolves an empty configuration and refuses with "No D1 database id is
// configured", while the operator's `staging` environment is fully populated and
// visible to nobody who can see it. The plan is not merely incomplete: it is
// wrong about the same project the apply job is about to deploy.
//
// The opposite mistake is to give the `plan` job the environment and hand it
// deploy authority, which is the one thing it must not have.
//
// The resolution is a third model, and it is the one GitHub's own scoping
// supports:
//
//   * **Repository-scoped** configuration — visible to every job, secret-free —
//     carries the whole nonsecret target map. This is what `plan` reads.
//   * **Environment-scoped** *secrets* stay exactly where they are, on the
//     protected environment, reachable only by the apply job.
//
// Nothing about the plan is trusted to come from the environment, and nothing
// about the environment is trusted to be nonsecret.
//
// ── Why one JSON map rather than two dozen scalar variables ──────────────────
//
// A resolved target is thirteen fields per environment. As scalar repository
// variables that is twenty-six names to type correctly, each of which can be
// wrong in a way that produces a *different* target rather than an error — and a
// mistyped bucket name is discovered when an encode writes nowhere.
//
// The map is one value, it is reviewed in one place, and it is validated by
// `EnvironmentTargetsSchema` before any of it reaches `resolveTarget`: an unknown
// key is refused rather than ignored. Per-field repository variables
// (`STARTER_STAGING_MEDIA_BUCKET_NAME`) are still honoured as overrides, for the
// operator who keeps configuration in the settings UI one row at a time.
//
// ── The one unsuffixed override, and why it is safe ───────────────────────────
//
// `CLOUDFLARE_WORKER_NAME` and its siblings existed before this file and are what
// a CI run uses to state *the environment it is deploying*. They are applied
// **only** when `DEPLOY_ENVIRONMENT` names that same environment, and only on top
// of that environment's entry. That is what makes them safe to compare across
// environments: they never are, because they only ever apply to one.
//
// It is also why `environmentIsolationProblem` must compare the *configuration*
// rather than the injected values — see the note there.
//
// ── What this module is not ──────────────────────────────────────────────────
//
// It never reads, writes or validates a secret. `CLOUDFLARE_API_TOKEN`,
// `BETTER_AUTH_SECRET` and `RESEND_API_KEY` are not here, are not part of the map
// schema, and are refused by the schema's closed object if someone tries to add
// them: a secret in a repository variable is a secret in every workflow log that
// echoes the resolved target.

import type { DeploymentEnvironment } from '@starter/schemas';
import { checkSchema } from '@starter/schemas/common';
import {
  DeploymentEnvironmentMapSchema,
  ENVIRONMENT_TARGET_FIELDS,
  type EnvironmentTargets,
  nullTargets,
} from '../registry/app_registry.ts';

/**
 * The environment a run is deploying, stated by the workflow.
 *
 * The name is deliberately not `NODE_ENV`: this is a *destination*, and a variable
 * called `NODE_ENV` in a deploy pipeline is a value that means two things.
 */
export const DEPLOY_ENVIRONMENT_VARIABLE = 'DEPLOY_ENVIRONMENT';

/** The account, which is not per environment. Repository-scoped and nonsecret. */
export const ACCOUNT_ID_VARIABLE = 'CLOUDFLARE_ACCOUNT_ID';

/** The one repository variable holding every environment's nonsecret target. */
export const ENVIRONMENT_MAP_VARIABLE = 'STARTER_DEPLOYMENT_TARGETS';

export const DEPLOYABLE_ENVIRONMENT_NAMES = ['staging', 'production'] as const;

/**
 * The repository variable that overrides one field of one environment.
 *
 * `STARTER_STAGING_MEDIA_BUCKET_NAME`. Explicit rather than compact because a
 * name that can be guessed from a convention is a name that can be *mis*guessed,
 * and a mis-guess here silently selects a different bucket.
 */
export const targetFieldVariable = (
  environment: DeploymentEnvironment,
  field: (typeof ENVIRONMENT_TARGET_FIELDS)[number],
): string =>
  `STARTER_${environment.toUpperCase()}_${field.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;

/** Every per-field variable name, so `deploy:status` can report what it looked for. */
export const allTargetFieldVariables = (): string[] =>
  DEPLOYABLE_ENVIRONMENT_NAMES.flatMap((environment) =>
    ENVIRONMENT_TARGET_FIELDS.map((field) => targetFieldVariable(environment, field)),
  );

/**
 * The unsuffixed override variables, and the field each one sets.
 *
 * Applied only to `DEPLOY_ENVIRONMENT`. Kept as an explicit table rather than
 * derived from a naming convention, because a convention that maps a field name to
 * a variable name would also map `d1DatabaseId` to something an operator sets by
 * habit and CI sets by accident.
 */
export const DEPLOY_OVERRIDE_VARIABLES: Readonly<Record<string, keyof EnvironmentTargets>> = {
  CLOUDFLARE_WORKER_NAME: 'workerName',
  CLOUDFLARE_JOBS_WORKER_NAME: 'jobsWorkerName',
  CLOUDFLARE_D1_DATABASE_ID: 'd1DatabaseId',
  CLOUDFLARE_MEDIA_BUCKET_NAME: 'mediaBucketName',
  CLOUDFLARE_PUBLIC_ORIGIN: 'origin',
  CLOUDFLARE_MAIL_FROM: 'mailFrom',
  CLOUDFLARE_NATIVE_API_ORIGIN: 'nativeApiOrigin',
} as const;

/** Names a variable may never carry, whatever a hand-edited map says. */
const SECRET_LIKE = /SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL/i;

export interface MapProblem {
  message: string;
  remedy: string;
  /**
   * Which environment the problem belongs to, or `null` for the map as a whole.
   *
   * Load-bearing after a bug: a malformed entry was parsed away and the whole map
   * read as empty, so `deploy status` reported "No Worker name is configured" for an
   * operator whose map was present and spelled wrong. The cause was four steps
   * further away than the symptom. Scoping the refusal to one environment keeps
   * staging plannable while production's typo is still named rather than swallowed.
   */
  environment?: string | null;
}

/**
 * Always carries both the best-effort map and the problems.
 *
 * One shape rather than a success/failure union, because a partial map plus its
 * problems is the real answer: an operator who mistyped `workrName` in staging has a
 * perfectly good production entry, and a parser that threw the whole value away
 * turned one typo into two unconfigured environments.
 */
export interface MapResult {
  ok: boolean;
  map: Partial<Record<DeploymentEnvironment, EnvironmentTargets>>;
  problems: MapProblem[];
}

/**
 * Parse the repository environment map, or refuse with every problem at once.
 *
 * Two rules, both load-bearing:
 *
 *   * **Closed.** An unrecognised key is refused. A map with a typo would
 *     otherwise resolve with that field `null`, the target would refuse for a
 *     missing value, and the actual cause — the typo — would be several steps
 *     further away than the thing it caused.
 *   * **No secrets.** A key that looks like a credential is refused with its name.
 *     `wrangler` and this pipeline echo resolved targets into plans and release
 *     records; a secret in the map would be written to both.
 *
 * All problems are reported together rather than one per run, because a CI
 * operator fixing a map fixes it against the whole list.
 */
export const parseEnvironmentMap = (raw: string | undefined): MapResult => {
  if (raw === undefined || raw.trim() === '') {
    return { ok: true, map: {}, problems: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      map: {},
      problems: [
        {
          message: `${ENVIRONMENT_MAP_VARIABLE} is not valid JSON: ${
            error instanceof Error ? error.message : 'parse error'
          }`,
          remedy:
            'The value must be a JSON object keyed by environment, e.g.\n' +
            '  {"staging": {"workerName": "…", "d1DatabaseId": "…"}}',
          environment: null,
        },
      ],
    };
  }

  const problems: MapProblem[] = [];
  const map: Partial<Record<DeploymentEnvironment, EnvironmentTargets>> = {};

  if (!checkSchema(DeploymentEnvironmentMapSchema, parsed)) {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      problems.push({
        message: `${ENVIRONMENT_MAP_VARIABLE} must be a JSON object keyed by environment.`,
        remedy: `Valid keys: ${DEPLOYABLE_ENVIRONMENT_NAMES.join(', ')}.`,
        environment: null,
      });
      return { ok: false, map, problems };
    }

    for (const [environment, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (!(DEPLOYABLE_ENVIRONMENT_NAMES as readonly string[]).includes(environment)) {
        problems.push({
          message: `"${environment}" is not a deployable environment in ${ENVIRONMENT_MAP_VARIABLE}.`,
          remedy: `Valid keys: ${DEPLOYABLE_ENVIRONMENT_NAMES.join(', ')}.`,
          environment: null,
        });
        continue;
      }

      // Read the entry even when it has a problem in it. The fields that *are*
      // spelled correctly are still configuration, and discarding them would turn a
      // single typo into an unconfigured environment.
      const targets = nullTargets();
      for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
        if (
          (ENVIRONMENT_TARGET_FIELDS as readonly string[]).includes(key) &&
          (value === null || typeof value === 'string')
        ) {
          targets[key as keyof EnvironmentTargets] =
            typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
        }
      }
      if (Object.values(targets).some((value) => value !== null)) {
        map[environment as DeploymentEnvironment] = targets;
      }

      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        problems.push({
          message: `The "${environment}" entry must be an object.`,
          remedy: `Keys: ${ENVIRONMENT_TARGET_FIELDS.join(', ')}.`,
          environment,
        });
        continue;
      }

      for (const [field, value] of Object.entries(entry as Record<string, unknown>)) {
        if (SECRET_LIKE.test(field)) {
          problems.push({
            message: `"${environment}.${field}" looks like a credential.`,
            remedy:
              `${ENVIRONMENT_MAP_VARIABLE} is not a secret channel and is echoed into plans and\n` +
              '  release records. Store credentials as environment secrets and install them\n' +
              '  with `bun run deploy:secrets --env ' +
              environment +
              '`.',
            environment,
          });
          continue;
        }

        if (!(ENVIRONMENT_TARGET_FIELDS as readonly string[]).includes(field)) {
          problems.push({
            message: `"${environment}.${field}" is not a target field.`,
            remedy: `Valid fields: ${ENVIRONMENT_TARGET_FIELDS.join(', ')}.`,
            environment,
          });
          continue;
        }

        if (value !== null && typeof value !== 'string') {
          problems.push({
            message: `"${environment}.${field}" must be a string or null.`,
            remedy:
              'Every value in the map is either a resource name or `null` for "not provisioned".',
            environment,
          });
          continue;
        }

        if (typeof value === 'string' && value.trim() === '') {
          problems.push({
            message: `"${environment}.${field}" is an empty string.`,
            remedy:
              'Use `null` for "not provisioned". An empty string satisfies a length check\n' +
              '  while provisioning nothing, which is how a deployment looks configured and\n' +
              '  is not.',
          });
        }
      }
    }

    return { ok: false, map, problems };
  }

  for (const [environment, entry] of Object.entries(
    parsed as Record<string, EnvironmentTargets | undefined>,
  )) {
    if (entry === undefined) {
      continue;
    }
    const targets = nullTargets();
    for (const field of ENVIRONMENT_TARGET_FIELDS) {
      const value = entry[field];
      targets[field] = typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
    }
    map[environment as DeploymentEnvironment] = targets;
  }

  return { ok: true, map, problems };
};

const usable = (value: string | undefined): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

/**
 * The nonsecret target layer as it arrives in a process environment.
 *
 * Read order, least specific first, because every layer here can be wrong:
 *
 *   1. the repository-level JSON map (whole environments),
 *   2. repository-level per-field variables (one field, one environment),
 *   3. nothing else. The unsuffixed overrides are *not* applied here; they belong
 *      to the environment actually being deployed, and are handled by
 *      `deployOverridesFor`.
 */
export const readRepositoryLayer = (
  env: NodeJS.ProcessEnv = process.env,
): {
  map: Partial<Record<DeploymentEnvironment, EnvironmentTargets>>;
  /** Refusals, kept rather than swallowed. See {@link MapProblem.environment}. */
  problems: MapProblem[];
} => {
  const parsed = parseEnvironmentMap(env[ENVIRONMENT_MAP_VARIABLE]);
  const map = parsed.map;
  const problems = parsed.problems;

  for (const environment of DEPLOYABLE_ENVIRONMENT_NAMES) {
    const entry = map[environment] ?? nullTargets();

    let touched = map[environment] !== undefined;
    for (const field of ENVIRONMENT_TARGET_FIELDS) {
      const value = usable(env[targetFieldVariable(environment, field)]);
      if (value !== null) {
        entry[field] = value;
        touched = true;
      }
    }

    if (touched) {
      map[environment] = entry;
    }
  }

  return { map, problems };
};

/**
 * The unsuffixed overrides, applied **only** to the environment being deployed.
 *
 * Returns `{}` when `DEPLOY_ENVIRONMENT` is absent or names something this
 * project does not deploy. That guard is the whole reason these variables are
 * safe: without it, one `CLOUDFLARE_WORKER_NAME` describes both environments and
 * `environmentIsolationProblem` refuses every plan forever.
 */
export const deployOverridesFor = (
  environment: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Partial<EnvironmentTargets> => {
  if (environment === undefined || !DEPLOYABLE_ENVIRONMENT_NAMES.includes(environment as never)) {
    return {};
  }

  const overrides: Partial<EnvironmentTargets> = {};
  for (const [variable, field] of Object.entries(DEPLOY_OVERRIDE_VARIABLES)) {
    const value = usable(env[variable]);
    if (value !== null) {
      overrides[field] = value;
    }
  }
  return overrides;
};

// ── GitHub's variable scope, as a model a test can drive ──────────────────────
//
// The paragraph at the top of this file is the reason the plan job exists in its
// current shape. A claim about a provider's scoping is worth asserting, not just
// asserting in prose — so the rule is modelled as data, and the model is what the
// test drives.

/** Which variables a job can see, given whether it declares an environment. */
export type VariableScope = 'repository' | { environment: string };

export interface ScopedVariable {
  name: string;
  scope: VariableScope;
}

export interface JobVisibility {
  name: string;
  /** `null` for the `plan` job, which deliberately has no `environment:`. */
  environment: string | null;
}

/**
 * The variable names a job may read.
 *
 * Environment-scoped configuration is visible only to a job that declares that
 * environment — which is the fact that makes a credential-free plan possible and a
 * credentials-holding environment safe at the same time.
 */
export const visibleVariables = (
  job: JobVisibility,
  variables: readonly ScopedVariable[],
): string[] =>
  variables
    .filter((variable) => {
      if (job.environment === null) {
        return variable.scope === 'repository';
      }
      return (
        variable.scope === 'repository' ||
        (typeof variable.scope === 'object' && variable.scope.environment === job.environment)
      );
    })
    .map((variable) => variable.name);

/** The jobs this workflow has, so the scope model and the YAML name the same two. */
export const DEPLOY_JOBS = [
  { name: 'plan', environment: null },
  // The apply job's environment is the dispatch input; there is no fixed name to
  // record here because the environment is a choice, not a constant.
  { name: 'apply', environment: '(the dispatched environment)' },
] as const satisfies readonly JobVisibility[];

// scripts/src/registry/deployment_values.ts
//
// Where a developer's real resource ids live.
//
// The problem this solves: `deploy:configure --provision` created a D1 database
// and wrote its id into `wrangler.jsonc`. That is one of two files the tooling
// reads, so provisioning could never complete — `deploy:check` and `db:migrate`
// read `DEPLOYMENT_CONFIG` in `app_registry.ts`, which stayed `null` forever. The
// documented remedy, "add the id by hand", pointed at a module a guard forbids:
// `registry-valid` fails the build if a resource id is a literal there, because a
// committed id would make a fresh clone target somebody else's account.
//
// So there are now three layers, and this is the middle one:
//
//   1. `app_registry.ts`   committed defaults. Always `null` for resource ids,
//                          enforced by the `registry-valid` guard.
//   2. THIS FILE           `.starter/deployment.local.json`, gitignored. Written
//                          by `deploy:configure --provision`. The only place a real
//                          id lives, and therefore the only thing `deploy:check`
//                          consults for one.
//   3. environment         `CLOUDFLARE_ACCOUNT_ID` and friends, so CI can inject
//                          rather than persist.
//
// Read order is 3, then 2, then 1 — most specific and least persistent first. A
// value that exists in more than one place is a value nobody can tell is in
// effect, so `describeResolution` names which layer answered.
//
// The local file is gitignored and `source-is-tracked` covers `.starter/**` once
// that path is added to `.gitignore`. It is not read at import time from a
// hardcoded relative path: `REPO_ROOT` is resolved once in `shared/paths.ts`, and
// a wrong `../` depth there is silent and reads as a missing config file.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeploymentEnvironment } from '@starter/schemas';
import {
  DEPLOY_ENVIRONMENT_VARIABLE,
  deployOverridesFor,
  readRepositoryLayer,
} from '../deploy/variables.ts';
import { REPO_ROOT } from '../shared/paths.ts';
import {
  DEPLOYMENT_CONFIG,
  type DeploymentConfig,
  ENVIRONMENT_TARGET_FIELDS,
  type EnvironmentTargets,
  type JobsProfile,
  nullTargets,
} from './app_registry.ts';

export type { EnvironmentTargets, JobsProfile };

/** The gitignored overlay. One file, one shape, documented in docs/cloudflare.md. */
export const LOCAL_DEPLOYMENT_FILE = '.starter/deployment.local.json';

export interface DeploymentValues {
  workerName: string | null;
  d1DatabaseId: string | null;
  r2BucketNames: { uploads: string | null };
  customDomain: string | null;
  accountId: string | null;
  /**
   * The compute profile for the single-set fallback, mirroring the committed
   * default of `disabled`.
   *
   * `disabled` is the answer for a template that has provisioned nothing, and it
   * is a *refusal* rather than an absence: with it, `deploy plan` describes a
   * web-only release and `apply` never builds an image. Defaulting to it is
   * therefore the conservative direction — the alternative default would have a
   * fresh clone plan a container build for an account it has no access to.
   *
   * Anything else has to be said out loud, per environment.
   */
  jobsProfile: JobsProfile;
  /**
   * Per-environment targets, or absent when the project has only ever had one
   * environment.
   *
   * One set of names cannot describe a real deployment: a Worker is named once per
   * account, so staging and production are two Workers and two databases. With one
   * set, `--env staging` and `--env production` produced identical plans — the flag
   * changed a notice and nothing else.
   *
   * `Partial` because presence is the signal: a project that has only staging must
   * be able to say so. Requiring every environment would force a placeholder entry
   * for one that does not exist, and a placeholder is indistinguishable from a real
   * name unless it is `null` — which is exactly the ambiguity this layer removes.
   *
   * `local` is included for completeness but never carries a Worker: there is no
   * remote target for it, and `bun run dev` is the local story.
   *
   * Absent means "no per-environment layer", not "no environments": a single-set
   * project keeps working, and `targetsFor` refuses only when the map exists and the
   * requested environment is absent from it.
   */
  environments?: Partial<Record<DeploymentEnvironment, EnvironmentTargets>>;

  /**
   * Values injected by the environment layer, kept separate rather than merged.
   *
   * Separate because of precedence: a per-environment entry must beat the
   * single-set, and only an *injected* value beats the entry. Merging the CI values
   * into the top-level fields instead made the single-set override every
   * environment, which is how a project's own staging Worker name was replaced by a
   * leftover top-level value.
   */
  injected?: Partial<EnvironmentTargets>;
  /**
   * Which environment `injected` describes, or `null` when nothing was injected.
   *
   * Load-bearing, and absent until the CI override layer was scoped. An injected
   * value describes *the environment this run is deploying*; applied to every
   * environment it describes all of them at once, which is the opposite — and it
   * made `topologyFor('production')` answer with staging's Worker during a staging
   * run, so a production plan printed staging's destination.
   */
  injectedEnvironment?: DeploymentEnvironment | null;
  /**
   * Refusals from the CI variable layer, per environment.
   *
   * Carried rather than swallowed so `resolveTarget` can name a *mistyped field*
   * instead of reporting "No Worker name is configured" for a map that has one.
   * `null` key means the map itself is malformed and every environment is affected.
   */
  configurationProblems?: Partial<Record<DeploymentEnvironment, string[]>>;
}

/**
 * What the gitignored overlay may contain.
 *
 * Two levels of partiality, and the second one is not optional convenience:
 *
 *   * Every top-level key may be absent — a read-modify-write must preserve keys
 *     it does not touch, and `--provision` for the database must not erase a
 *     Worker name someone already set.
 *   * Each *environment entry* is partial too. `deploy:configure --env staging
 *     --worker x` writes one field for one environment; requiring a complete
 *     `EnvironmentTargets` would force the command to invent values for
 *     production as well, and an invented name is indistinguishable from a real
 *     one unless it is `null` — which is exactly the ambiguity the per-environment
 *     layer exists to remove.
 *
 * The overlay is therefore a `Partial` at both levels, and `readLocalFile` is the
 * only thing that turns it back into a complete `DeploymentValues`.
 */
export type LocalDeploymentValues = Omit<
  {
    [K in keyof DeploymentValues]?: DeploymentValues[K] extends object
      ? Partial<DeploymentValues[K]>
      : DeploymentValues[K];
  },
  'environments'
> & {
  environments?: Partial<Record<DeploymentEnvironment, Partial<EnvironmentTargets>>>;
};

const NULL_VALUES: DeploymentValues = {
  workerName: null,
  d1DatabaseId: null,
  r2BucketNames: { uploads: null },
  customDomain: null,
  accountId: null,
  jobsProfile: 'disabled',
};

/**
 * Every environment target field, as a record of `null`.
 *
 * One constructor rather than thirteen literals, because a field added to
 * {@link ENVIRONMENT_TARGET_FIELDS} and forgotten here would be `undefined` in a
 * partial entry — which is indistinguishable from "not set" everywhere except in
 * the one place it matters: a value that silently falls back to the single set.
 */
export { nullTargets };

/** A string that is actually usable. Empty and whitespace are "not set". */
const usable = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

const objectSection = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** Read only the local layer, preserving keys that the writer does not change. */
export const readLocalValues = (root: string): LocalDeploymentValues => {
  const path = join(root, LOCAL_DEPLOYMENT_FILE);
  if (!existsSync(path)) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // Reported rather than thrown: a malformed local file must not make every
    // command that touches the registry fail with a stack trace. `deploy:check`
    // surfaces the detail through `localConfigProblem`, which is where the parse
    // error text actually reaches the operator.
    return {};
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {};
  }

  return objectSection(parsed) ?? {};
};

const readLocalFile = (root: string): Partial<DeploymentValues> => {
  const raw = readLocalValues(root);
  const out: Partial<DeploymentValues> = {};

  const r2 = objectSection(raw.r2BucketNames);

  if (raw.workerName !== undefined) {
    out.workerName = usable(raw.workerName);
  }
  if (raw.d1DatabaseId !== undefined) {
    out.d1DatabaseId = usable(raw.d1DatabaseId);
  }
  if (r2 !== undefined) {
    out.r2BucketNames = { uploads: usable(r2.uploads) ?? null };
  }
  if (raw.customDomain !== undefined) {
    out.customDomain = usable(raw.customDomain);
  }
  const account = usable(raw.accountId);
  if (account !== null) {
    out.accountId = account;
  }

  // Per-environment targets. Parsed rather than trusted: an environment whose entry
  // is not an object is skipped, so one typo cannot make a whole plan `undefined`
  // and silently fall back to the single set — which is the no-op this shape exists
  // to prevent.
  //
  // Every known field is read, including the ones this layer did not have when the
  // shape was first written. An unknown key is *dropped* here on purpose: the file
  // is hand-edited, and refusing to read it because of a comment-shaped key would
  // make the tool unusable. The strict check belongs where the value is
  // machine-supplied — `variables.ts`, against `EnvironmentTargetsSchema`.
  const environments = raw.environments;
  if (typeof environments === 'object' && environments !== null) {
    const parsed: Partial<Record<DeploymentEnvironment, EnvironmentTargets>> = {};
    for (const [name, value] of Object.entries(environments)) {
      if (name !== 'staging' && name !== 'production') {
        continue;
      }
      const entry = objectSection(value);
      if (entry === undefined) {
        continue;
      }

      const targets = nullTargets();
      for (const field of ENVIRONMENT_TARGET_FIELDS) {
        const raw_field = entry[field];
        if (raw_field === undefined) {
          continue;
        }
        // `null` is preserved as "not provisioned for this field", which is
        // different from the key being absent: an explicit null is a decision, and
        // it must not fall back to the single set either.
        targets[field] = usable(raw_field);
      }
      parsed[name] = targets;
    }
    if (Object.keys(parsed).length > 0) {
      out.environments = parsed as Record<DeploymentEnvironment, EnvironmentTargets>;
    }
  }

  return out;
};

/**
 * The effective values, after environment, local file and defaults are folded.
 *
 * `env` is a parameter so precedence is assertable without mutating the process.
 */
export const resolveDeploymentValues = (
  env: NodeJS.ProcessEnv = process.env,
  root: string = REPO_ROOT,
): DeploymentValues => {
  const local = readLocalFile(root);

  // Defaults, with the committed module as the floor.
  const merged: DeploymentValues = {
    workerName: DEPLOYMENT_CONFIG.workerName,
    d1DatabaseId: DEPLOYMENT_CONFIG.d1DatabaseId,
    r2BucketNames: { ...NULL_VALUES.r2BucketNames, ...DEPLOYMENT_CONFIG.r2BucketNames },
    customDomain: DEPLOYMENT_CONFIG.customDomain,
    accountId: DEPLOYMENT_CONFIG.accountId,
    jobsProfile: NULL_VALUES.jobsProfile,
  };

  // Layer 2: the gitignored local file.
  if (local.workerName !== undefined) {
    merged.workerName = local.workerName;
  }
  if (local.d1DatabaseId !== undefined) {
    merged.d1DatabaseId = local.d1DatabaseId;
  }
  if (local.r2BucketNames !== undefined) {
    merged.r2BucketNames = { ...merged.r2BucketNames, ...local.r2BucketNames };
  }
  if (local.customDomain !== undefined) {
    merged.customDomain = local.customDomain;
  }
  if (local.accountId !== undefined) {
    merged.accountId = local.accountId;
  }
  if (local.environments !== undefined) {
    merged.environments = local.environments;
  }

  // Layer 3: the environment, which is what CI injects instead of persisting.
  //
  // These populate the *single set* as well as `injected`, and deliberately are not
  // copied into every environment entry. Copying them was a live
  // production-safety defect: a `CLOUDFLARE_D1_DATABASE_ID` present in both
  // `staging` and `production` means the two environments are the same database,
  // and a staging migration is then a production migration. The values describe
  // *one* environment — the one being deployed — and a set that described all of
  // them at once would be saying they are the same.
  //
  // Which one is decided by `DEPLOY_ENVIRONMENT`, not by guessing: the same
  // unsuffixed variable applied to both environments is exactly the shared-
  // destination configuration this layer refuses. See `deploy/variables.ts`.
  const injected: Partial<EnvironmentTargets> = {};
  const take = (field: keyof EnvironmentTargets, value: string | null): void => {
    if (value !== null) {
      injected[field] = value;
    }
  };

  const fromEnv = usable(env.CLOUDFLARE_ACCOUNT_ID);
  if (fromEnv !== null) {
    merged.accountId = fromEnv;
  }

  const repositoryLayer = readRepositoryLayer(env);

  // Recorded before the values are merged, so a malformed entry cannot be read as
  // "not configured" — the two have completely different remedies.
  if (repositoryLayer.problems.length > 0) {
    const byEnvironment: Record<string, string[]> = {};
    for (const problem of repositoryLayer.problems) {
      const key = problem.environment ?? '*';
      const existing = byEnvironment[key] ?? [];
      existing.push(`${problem.message}\n  ${problem.remedy}`);
      byEnvironment[key] = existing;
    }
    merged.configurationProblems = byEnvironment as Partial<
      Record<DeploymentEnvironment, string[]>
    >;
  }

  if (Object.keys(repositoryLayer.map).length > 0) {
    // Merged field by field into whatever layer 2 already said, so a repository
    // variable overrides a checked-in overlay entry for that field alone and
    // leaves the rest of the environment alone. Overwriting the whole entry would
    // make one CI variable erase a hand-configured origin.
    const environments: Partial<Record<DeploymentEnvironment, EnvironmentTargets>> = {
      ...(merged.environments ?? {}),
    };
    for (const [name, entry] of Object.entries(repositoryLayer.map)) {
      const environment = name as DeploymentEnvironment;
      const existing = environments[environment] ?? nullTargets();
      const merged_entry = nullTargets();
      for (const field of ENVIRONMENT_TARGET_FIELDS) {
        merged_entry[field] = entry[field] ?? existing[field] ?? null;
      }
      environments[environment] = merged_entry;
    }
    merged.environments = environments;
  }

  for (const [field, value] of Object.entries(
    deployOverridesFor(env[DEPLOY_ENVIRONMENT_VARIABLE], env),
  )) {
    const typed = field as keyof EnvironmentTargets;
    take(typed, usable(value));
  }

  // Kept so a report can name the single field whose layer is not per-environment:
  // the account, which every environment shares.
  const workerFromEnv = injected.workerName;
  if (workerFromEnv !== null && workerFromEnv !== undefined) {
    merged.workerName = workerFromEnv;
  }
  if (injected.d1DatabaseId !== undefined) {
    merged.d1DatabaseId = injected.d1DatabaseId;
  }
  if (injected.origin !== undefined) {
    merged.customDomain = injected.origin;
  }

  if (Object.keys(injected).length > 0) {
    merged.injected = injected;
    const named = env[DEPLOY_ENVIRONMENT_VARIABLE];
    merged.injectedEnvironment = named === 'staging' || named === 'production' ? named : null;
  }

  return merged;
};

/**
 * Why the local file could not be read, or null when it is fine.
 *
 * Separate from `resolveDeploymentValues` because a malformed file must not be
 * silently "no values configured": that reads as "you have not provisioned yet"
 * and sends the operator to the wrong command.
 */
export const localConfigProblem = (root: string = REPO_ROOT): string | null => {
  const path = join(root, LOCAL_DEPLOYMENT_FILE);
  if (!existsSync(path)) {
    return null;
  }
  try {
    if (objectSection(JSON.parse(readFileSync(path, 'utf8'))) === undefined) {
      return `${LOCAL_DEPLOYMENT_FILE} must contain a JSON object.`;
    }
    return null;
  } catch (error) {
    return (
      `${LOCAL_DEPLOYMENT_FILE} is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}\n` +
      '  Every value in it is being ignored, so this project looks unprovisioned.'
    );
  }
};

/** Where one value came from, so a report can name it rather than guess. */
export type ResolutionLayer = 'environment' | 'local-file' | 'default';

// `FROM_ENV` is total over `field`, so the `?? ''` below is unreachable and exists
// only to satisfy the index type. `usable('')` is `null`, so the unreachable branch
// reads as "not set" — the same answer the default path gives.
export const describeResolution = (
  field: 'accountId' | 'd1DatabaseId' | 'workerName' | 'origin',
  env: NodeJS.ProcessEnv = process.env,
  root: string = REPO_ROOT,
): ResolutionLayer => {
  const FROM_ENV: Record<typeof field, NodeJS.ProcessEnv[string]> = {
    accountId: 'CLOUDFLARE_ACCOUNT_ID',
    d1DatabaseId: 'CLOUDFLARE_D1_DATABASE_ID',
    workerName: 'CLOUDFLARE_WORKER_NAME',
    origin: 'CLOUDFLARE_PUBLIC_ORIGIN',
  };

  if (usable(env[FROM_ENV[field] ?? '']) !== null) {
    return 'environment';
  }

  const local = readLocalFile(root);

  // `origin` has no top-level key on the resolved values — it lives per
  // environment — so it is handled separately below rather than indexed here,
  // which would need a cast to compile and would then answer about the wrong key.
  if (field !== 'origin') {
    const fromLocal = local[field];
    if (typeof fromLocal === 'string' && fromLocal !== '') {
      return 'local-file';
    }
    return 'default';
  }

  const fromTopLevel = local.customDomain;
  if (usable(fromTopLevel) !== null) {
    return 'local-file';
  }

  for (const entry of Object.values(local.environments ?? {})) {
    if (usable(entry.origin) !== null) {
      return 'local-file';
    }
  }

  return 'default';
};

/** Shape written to the local file. Exported so the writer and reader cannot drift. */
export type { DeploymentConfig };

// ── Test seam ────────────────────────────────────────────────────────────────
//
// The values are read through this resolver rather than off `DEPLOYMENT_CONFIG`
// directly, because provisioning writes the gitignored overlay plus the
// environment, and the committed module is only the floor.
//
// That makes injection necessary rather than convenient. A test that mutated the
// committed module to simulate a provisioned project would be testing a path
// production never takes — and that is exactly how the original bug survived:
// every deploy test passed while `deploy:check` read `null` forever, because the
// tests set the one value the code did not read.

let injected: DeploymentValues | null = null;

/** Install values for the duration of a test. `null` restores real resolution. */
export const setDeploymentValues = (next: DeploymentValues | null): void => {
  injected = next;
};

/** The effective values, honouring any injected test values. */
export const effectiveDeploymentValues = (): DeploymentValues =>
  injected ?? resolveDeploymentValues();

/**
 * What a plan may use, given the environment it targets.
 *
 * Lives here rather than in `app_registry.ts` because it reads the resolved values,
 * and putting it next to the committed defaults would make the two modules import
 * each other.
 *
 * One set of names cannot describe a real deployment: a Worker is named once per
 * account, so staging and production are two Workers and two databases. With one
 * set, `--env staging` and `--env production` produced *identical* plans — the flag
 * changed a notice and nothing else, which is the worst kind of no-op because the
 * plan looked environment-specific.
 *
 * `null` means the caller asked for an environment this project has no topology for,
 * and is refused rather than defaulted. Absent `environments` means the project has
 * only ever had one, so the single set still applies.
 */
/**
 * The configured topology for one environment, or `null`.
 *
 * The layer-1 fallback is consulted only when the project has never declared
 * per-environment targets. A project that has *some* environments gets a refusal
 * for the ones it does not, which is what stops `--env production` from being
 * served staging's Worker.
 */
export const topologyFor = (
  environment: DeploymentEnvironment,
  values: DeploymentValues = effectiveDeploymentValues(),
): EnvironmentTargets | null => {
  // The single-set fallback. It carries the web Worker, database and origin — the
  // three fields that predate the compute half — and *nothing* else: the jobs
  // Worker, the bucket, the workflows and the image have no single-set meaning,
  // because a project that has never described two environments has still never
  // said which image it trusts. Inventing those here is how a web-only
  // configuration would quietly grow a container it cannot build.
  const fallback = nullTargets();
  fallback.workerName = values.workerName;
  fallback.d1DatabaseId = values.d1DatabaseId;
  fallback.origin = values.customDomain;
  fallback.jobsProfile = values.jobsProfile;

  // An environment the project does not describe has no topology. Refused rather
  // than defaulted, because serving a production request with staging names is the
  // outcome this whole layer exists to prevent.
  const base = values.environments === undefined ? fallback : values.environments[environment];
  if (base === undefined) {
    return null;
  }

  // Injected last: the environment layer is the most specific and least persistent,
  // so a CI run's values describe the environment being deployed and nothing else.
  // A stale local file naming production's database cannot be overridden into
  // staging by a CI variable, and a CI variable for staging cannot silently become
  // production's configuration.
  //
  // Field-by-field rather than three assignments, because a fifth and sixth field
  // arrived later and a hand-written list is how one of them gets forgotten.
  const injected = values.injected;
  if (injected === undefined || values.injectedEnvironment !== environment) {
    return base;
  }

  const resolved = nullTargets();
  for (const field of ENVIRONMENT_TARGET_FIELDS) {
    resolved[field] = injected[field] ?? base[field] ?? null;
  }
  return resolved;
};

/**
 * The configured topology with any per-run override removed.
 *
 * This is the *configured* answer, and `environmentIsolationProblem` compares it
 * rather than `topologyFor`. The distinction is the whole reason CI could ever plan:
 * an injected `CLOUDFLARE_WORKER_NAME` describes the environment being deployed
 * and only that environment, so applying it to both and then comparing them proves
 * nothing except that the variable was set — and reported it as "staging and
 * production share a Worker", which is what the plan job did on every run.
 */
export const configuredTopologyFor = (
  environment: DeploymentEnvironment,
  values: DeploymentValues = effectiveDeploymentValues(),
): EnvironmentTargets | null => {
  const { injected: _injected, ...configured } = values;
  return topologyFor(environment, configured);
};

/** Alias kept for existing callers; `topologyFor` is the name that says what it is. */
export const targetsFor = topologyFor;

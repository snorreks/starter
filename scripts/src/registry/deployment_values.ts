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
import { REPO_ROOT } from '../shared/paths.ts';
import {
  DEPLOYMENT_CONFIG,
  type DeploymentConfig,
  type EnvironmentTargets,
} from './app_registry.ts';

export type { EnvironmentTargets };

/** The gitignored overlay. One file, one shape, documented in docs/cloudflare.md. */
export const LOCAL_DEPLOYMENT_FILE = '.starter/deployment.local.json';

export interface DeploymentValues {
  workerName: string | null;
  d1DatabaseId: string | null;
  r2BucketNames: { uploads: string | null };
  customDomain: string | null;
  accountId: string | null;
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
}

export type LocalDeploymentValues = {
  [K in keyof DeploymentValues]?: DeploymentValues[K] extends object
    ? Partial<DeploymentValues[K]>
    : DeploymentValues[K];
};

const NULL_VALUES: DeploymentValues = {
  workerName: null,
  d1DatabaseId: null,
  r2BucketNames: { uploads: null },
  customDomain: null,
  accountId: null,
};

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

      parsed[name] = {
        workerName: usable(entry.workerName),
        d1DatabaseId: usable(entry.d1DatabaseId),
      };
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
  const fromEnv = usable(env.CLOUDFLARE_ACCOUNT_ID);
  if (fromEnv !== null) {
    merged.accountId = fromEnv;
  }
  const workerFromEnv = usable(env.CLOUDFLARE_WORKER_NAME);
  if (workerFromEnv !== null) {
    merged.workerName = workerFromEnv;
  }
  const d1FromEnv = usable(env.CLOUDFLARE_D1_DATABASE_ID);
  if (d1FromEnv !== null) {
    merged.d1DatabaseId = d1FromEnv;
    for (const target of Object.values(merged.environments ?? {})) {
      target.d1DatabaseId = d1FromEnv;
    }
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
  field: 'accountId' | 'd1DatabaseId' | 'workerName',
  env: NodeJS.ProcessEnv = process.env,
  root: string = REPO_ROOT,
): ResolutionLayer => {
  const FROM_ENV: Record<typeof field, NodeJS.ProcessEnv[string]> = {
    accountId: 'CLOUDFLARE_ACCOUNT_ID',
    d1DatabaseId: 'CLOUDFLARE_D1_DATABASE_ID',
    workerName: 'CLOUDFLARE_WORKER_NAME',
  };

  if (usable(env[FROM_ENV[field] ?? '']) !== null) {
    return 'environment';
  }

  const local = readLocalFile(root);
  const fromLocal = local[field];
  if (typeof fromLocal === 'string' && fromLocal !== '') {
    return 'local-file';
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
export const targetsFor = (environment: DeploymentEnvironment): EnvironmentTargets | null => {
  const values = effectiveDeploymentValues();

  if (values.environments === undefined) {
    return { workerName: values.workerName, d1DatabaseId: values.d1DatabaseId };
  }

  return values.environments[environment] ?? null;
};

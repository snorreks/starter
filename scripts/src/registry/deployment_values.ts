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
import { REPO_ROOT } from '../shared/paths.ts';
import { DEPLOYMENT_CONFIG, type DeploymentConfig } from './app_registry.ts';

/** The gitignored overlay. One file, one shape, documented in docs/cloudflare.md. */
export const LOCAL_DEPLOYMENT_FILE = '.starter/deployment.local.json';

export interface DeploymentValues {
  workerNames: { client: string | null; api: string | null };
  d1DatabaseIds: { api: string | null };
  r2BucketNames: { uploads: string | null };
  customDomains: { client: string | null; api: string | null };
  accountId: string | null;
}

const NULL_VALUES: DeploymentValues = {
  workerNames: { client: null, api: null },
  d1DatabaseIds: { api: null },
  r2BucketNames: { uploads: null },
  customDomains: { client: null, api: null },
  accountId: null,
};

/** A string that is actually usable. Empty and whitespace are "not set". */
const usable = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

const readLocalFile = (root: string): Partial<DeploymentValues> => {
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

  const raw = parsed as Record<string, unknown>;
  const out: Partial<DeploymentValues> = {};

  const workers = raw.workerNames as Record<string, unknown> | undefined;
  const d1 = raw.d1DatabaseIds as Record<string, unknown> | undefined;
  const r2 = raw.r2BucketNames as Record<string, unknown> | undefined;
  const domains = raw.customDomains as Record<string, unknown> | undefined;

  if (workers !== undefined) {
    out.workerNames = { client: usable(workers.client) ?? null, api: usable(workers.api) ?? null };
  }
  if (d1 !== undefined) {
    out.d1DatabaseIds = { api: usable(d1.api) ?? null };
  }
  if (r2 !== undefined) {
    out.r2BucketNames = { uploads: usable(r2.uploads) ?? null };
  }
  if (domains !== undefined) {
    out.customDomains = {
      client: usable(domains.client) ?? null,
      api: usable(domains.api) ?? null,
    };
  }
  const account = usable(raw.accountId);
  if (account !== null) {
    out.accountId = account;
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
    workerNames: { ...NULL_VALUES.workerNames, ...DEPLOYMENT_CONFIG.workerNames },
    d1DatabaseIds: { ...NULL_VALUES.d1DatabaseIds, ...DEPLOYMENT_CONFIG.d1DatabaseIds },
    r2BucketNames: { ...NULL_VALUES.r2BucketNames, ...DEPLOYMENT_CONFIG.r2BucketNames },
    customDomains: { ...NULL_VALUES.customDomains, ...DEPLOYMENT_CONFIG.customDomains },
    accountId: DEPLOYMENT_CONFIG.accountId,
  };

  // Layer 2: the gitignored local file.
  if (local.workerNames !== undefined) {
    merged.workerNames = { ...merged.workerNames, ...local.workerNames };
  }
  if (local.d1DatabaseIds !== undefined) {
    merged.d1DatabaseIds = { ...merged.d1DatabaseIds, ...local.d1DatabaseIds };
  }
  if (local.r2BucketNames !== undefined) {
    merged.r2BucketNames = { ...merged.r2BucketNames, ...local.r2BucketNames };
  }
  if (local.customDomains !== undefined) {
    merged.customDomains = { ...merged.customDomains, ...local.customDomains };
  }
  if (local.accountId !== undefined) {
    merged.accountId = local.accountId;
  }

  // Layer 3: the environment, which is what CI injects instead of persisting.
  const fromEnv = usable(env.CLOUDFLARE_ACCOUNT_ID);
  if (fromEnv !== null) {
    merged.accountId = fromEnv;
  }
  const apiFromEnv = usable(env.CLOUDFLARE_D1_DATABASE_ID);
  if (apiFromEnv !== null) {
    merged.d1DatabaseIds = { ...merged.d1DatabaseIds, api: apiFromEnv };
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
    JSON.parse(readFileSync(path, 'utf8'));
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

export const describeResolution = (
  field: 'accountId' | 'd1DatabaseIds.api' | 'workerNames.api',
  env: NodeJS.ProcessEnv = process.env,
  root: string = REPO_ROOT,
): ResolutionLayer => {
  if (field === 'accountId' && usable(env.CLOUDFLARE_ACCOUNT_ID) !== null) {
    return 'environment';
  }
  if (field === 'd1DatabaseIds.api' && usable(env.CLOUDFLARE_D1_DATABASE_ID) !== null) {
    return 'environment';
  }

  const local = readLocalFile(root);
  if (field === 'accountId' && local.accountId !== null && local.accountId !== undefined) {
    return 'local-file';
  }
  if (field === 'd1DatabaseIds.api') {
    const id = local.d1DatabaseIds?.api;
    if (id !== null && id !== undefined) {
      return 'local-file';
    }
  }
  if (field === 'workerNames.api') {
    const name = local.workerNames?.api;
    if (name !== null && name !== undefined) {
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

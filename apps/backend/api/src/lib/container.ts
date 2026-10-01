// apps/backend/api/src/lib/container.ts
//
// Bindings, the database handle and the auth instance — scoped to the binding
// set they belong to.
//
// Why a container rather than a module-level `let env`:
//
//   In a Cloudflare Worker, the `env` object is a stable, immutable view of the
//   Worker's bindings for the isolate's lifetime. It does not vary per request,
//   so it is not the hazard that the usual `setEnvForRequest(env)` pattern is.
//   That pattern is dangerous because it is *routinely* reused to stash the
//   **caller's identity**, and identity absolutely does vary per request: a
//   Worker isolate serves many concurrent requests, and the last caller wins for
//   all of them. The resulting bug — a user occasionally reading another user's
//   data — is rare, timing-dependent, and indistinguishable from an
//   authorization bug while you are debugging it.
//
//   So the two are separated deliberately:
//
//     * bindings / db / auth  -> a container, memoized per binding set
//     * user identity / trace -> built fresh for every request, in
//                                `buildRequestContext`, from the request itself
//
//   The memo is a `WeakMap` keyed on the `env` object rather than a module
//   variable, so there is no mutable module state at all: if the isolate is torn
//   down, the container goes with it and cannot outlive its bindings.

import { type BetterAuthInstance, createBetterAuth } from '@starter/auth';
import { accounts, deviceCodes, sessions, users } from '@starter/database';
import { parseTrustedOrigins } from '@starter/schemas/registry';
import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import {
  type ApiEnv,
  type DeploymentEnvName,
  LOCAL_DEFAULT_AUTH_URL,
  resolveAuthSecret,
  resolveDeploymentEnvironment,
} from '../env.ts';

// A `type`, not an `interface`, on purpose: `DrizzleD1Database<T>` constrains T
// to `Record<string, unknown>`, and an interface has no implicit index signature,
// so an interface here fails to typecheck.
type Schema = {
  users: typeof users;
  sessions: typeof sessions;
  accounts: typeof accounts;
  deviceCodes: typeof deviceCodes;
};

export interface Container {
  env: ApiEnv;
  db: DrizzleD1Database<Schema>;
  auth: BetterAuthInstance;
  /** Resolved, validated deployment environment name. */
  environment: DeploymentEnvName;
  /** True only when `DEPLOYMENT_ENV` explicitly names a local environment. */
  isLocal: boolean;
}

const containers = new WeakMap<ApiEnv, Container>();

export const requireBindings = (env: unknown): ApiEnv => {
  const candidate = env as ApiEnv | undefined;
  if (candidate === undefined || candidate.DB === undefined) {
    throw new Error(
      'The D1 binding "DB" is not available. Check the d1_databases binding in ' +
        'wrangler.jsonc, and start the API with `bun run dev:api` (wrangler dev).',
    );
  }
  return candidate;
};

/**
 * The container for a binding set. Built once per isolate.
 *
 * The auth instance is created here rather than per request: Better Auth is
 * expensive to construct and is stateless with respect to a request.
 *
 * Note that `DEPLOYMENT_ENV` is not validated here, so a misconfigured deployment
 * fails on the first request rather than at module load. That is deliberate and is
 * the only correct place for it: `fetch` is where `env` first exists.
 */
export const getContainer = (rawEnv: unknown): Container => {
  const env = requireBindings(rawEnv);

  const existing = containers.get(env);
  if (existing !== undefined) {
    return existing;
  }

  const resolved = resolveDeploymentEnvironment(env);
  if (!resolved.ok) {
    throw new Error(`Refusing to start: ${resolved.problem}\n\n${resolved.remedy}`);
  }

  const { environment, isLocal } = resolved;
  const db = drizzle(env.DB, { schema: { users, sessions, accounts, deviceCodes } });

  const container: Container = {
    env,
    db,
    environment,
    isLocal,
    auth: createBetterAuth(db, {
      baseURL: env.BETTER_AUTH_URL ?? LOCAL_DEFAULT_AUTH_URL,
      secret: resolveAuthSecret(env, isLocal),
      trustedOrigins: parseTrustedOrigins(env.TRUSTED_ORIGINS),
      ...(env.AUTH_RATE_LIMIT_MAX === undefined
        ? {}
        : { rateLimitMax: Number(env.AUTH_RATE_LIMIT_MAX) }),
    }),
  };

  containers.set(env, container);
  return container;
};

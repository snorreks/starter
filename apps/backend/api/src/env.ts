// apps/backend/api/src/env.ts
//
// Worker environment configuration.
//
// Read from the request-scoped bindings, never from a module-level variable.
// A module-level `let env` looks equivalent and is not: a Worker isolate serves
// many requests, and a value cached in module scope survives a request that
// changed it. The failure is rare, non-reproducible, and looks like a bug in the
// business logic. See src/lib/request_context.ts.

export type ApiEnv = {
  /** D1 binding. Required: the API has no in-memory store. */
  DB: D1Database;
  /** Optional R2 bucket for user uploads. */
  UPLOADS?: R2Bucket;
  /** Public base URL of this API. */
  BETTER_AUTH_URL?: string;
  /** Session signing secret. */
  BETTER_AUTH_SECRET?: string;
  /** Extra trusted origins, comma separated. */
  TRUSTED_ORIGINS?: string;
  /** Minimum level a log event must meet to be stored. */
  LOG_LEVEL?: string;
  /** Build identifier attached to every log event. Injected by the deploy step. */
  RELEASE?: string;
};

export const AUTH_SECRET_PLACEHOLDER = 'development-only-not-a-secret';

/**
 * Resolve the Better Auth secret.
 *
 * Fails closed in staging and production rather than falling back to a
 * development value. A predictable secret in production is not a weak session;
 * it is no session boundary at all, and it fails silently.
 */
export const resolveAuthSecret = (env: ApiEnv, isProductionLike: boolean): string => {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  if (secret !== undefined && secret.length > 0) {
    return secret;
  }
  if (isProductionLike) {
    throw new Error(
      'BETTER_AUTH_SECRET is not set. Refusing to start with a development secret. ' +
        'Set it with: wrangler secret put BETTER_AUTH_SECRET --env staging',
    );
  }
  return AUTH_SECRET_PLACEHOLDER;
};

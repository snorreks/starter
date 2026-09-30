// apps/backend/api/src/lib/worker_env.ts
//
// Read the request's Cloudflare bindings.
//
// Uses the `cloudflare:workers` global rather than an adapter-specific request
// property, so one documented place has to change if the serving adapter does.

import type { ApiEnv } from '../env.ts';

type WorkerGlobal = { env?: unknown };

/**
 * Per-request memo, keyed by the request object.
 *
 * A `WeakMap` rather than a symbol property on the request: it needs no type
 * assertion to read, and — more importantly — a memo keyed by the request cannot
 * outlive it. A symbol property would keep the bindings alive on an object that
 * is still reachable, which is the same class of mistake as caching env in a
 * module variable, just smaller.
 */
const memo = new WeakMap<Request, ApiEnv>();

export const getWorkerEnv = (request: Request): ApiEnv => {
  const cached = memo.get(request);
  if (cached !== undefined) {
    return cached;
  }

  const env = (globalThis as WorkerGlobal).env as ApiEnv | undefined;
  if (env === undefined || env.DB === undefined) {
    throw new Error(
      'The D1 binding "DB" is not available. Run the API with `wrangler dev` (see ' +
        'wrangler.jsonc), or declare the binding in your environment.',
    );
  }

  memo.set(request, env);
  return env;
};

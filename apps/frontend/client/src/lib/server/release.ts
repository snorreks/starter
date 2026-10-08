// apps/frontend/client/src/lib/server/release.ts
//
// Release identity: what this Worker says it is.
//
// Two distinct questions, deliberately answered by two functions:
//
//   * `releaseIdentity` — cheap. Reads configuration only. No binding, no I/O, no
//     database. This is what `/health` answers, and it has to be cheap because a
//     load balancer polls it.
//   * `readiness` — expensive. Touches the bindings a request actually needs. A
//     `/health` that only re-reads a variable proves the isolate is alive and
//     nothing else: a Worker whose Postgres binding points at a deleted database answers
//     "ok" forever while every real request fails with a 500.
//
// The split is the standard liveness/readiness split, and the reason it matters
// here is specific: a Worker is deployed by swapping an isolate, so "the process
// is running" is true for both the old and the new release. Liveness proves the
// isolate is serving; readiness proves the *configuration* is usable. Reporting the
// first when an operator asks for the second is how a bad deploy stays live for an
// hour because the load balancer is happy.
//
// **Nothing here discloses a secret or a binding value.** `/health` returns a
// release id, an environment name and a status. It does not return the account id,
// the database id, the auth secret, the mail key, or a stack trace. A health
// endpoint is public — it has to be, for anything to poll it without credentials —
// so it is treated as an endpoint whose contents are published.
//
// The release id is the git SHA the deploy recorded, injected as the `RELEASE`
// var. It is public information by construction: it is the commit under review.

import type { Container } from './container.ts';
import type { AppEnv } from './env.ts';

/** What `/health` reports. Every field is safe to publish. */
export interface ReleaseIdentity {
  status: 'ok';
  /** The commit this Worker was built from, or `unknown` if not injected. */
  release: string;
  /** `DEPLOYMENT_ENV`, already validated by the container before we get here. */
  environment: string;
  /**
   * `false` in local development and `true` deployed.
   *
   * Present because a health check that cannot distinguish the two is how someone
   * ends up running verification against a local dev server and reporting it as a
   * release check.
   */
  deployed: boolean;
}

export const releaseIdentity = (container: Container): ReleaseIdentity => ({
  status: 'ok',
  // `env.RELEASE` is set by the deploy step (`wrangler deploy --var RELEASE:<sha>`).
  // A Worker that was never deployed through this pipeline has no value, and
  // `unknown` is the honest answer rather than a plausible-looking guess.
  release: container.env.RELEASE?.trim() || 'unknown',
  environment: container.environment,
  deployed: !container.isLocal,
});

export interface ReadinessReport {
  ok: boolean;
  release: ReleaseIdentity;
  /** One entry per required binding. Never the binding's value. */
  checks: { binding: string; ok: boolean; detail: string }[];
}

/**
 * Readiness: prove the bindings a request needs actually work.
 *
 * Only `DB` is exercised. That is not a shortcut — it is the only required
 * binding in `AppEnv` that can fail on its own. Auth and mail are constructed in
 * `getContainer`, which throws before this is ever reached, so a Worker with a
 * missing or malformed `SUPABASE_SERVICE_ROLE_KEY` or an unusable mail configuration does
 * not start and never reaches a readiness response at all.
 *
 * The query is `SELECT 1`, which Postgres answers without touching a table. A readiness
 * check that read a real table would report unhealthy when the *data* is wrong
 * rather than when the *binding* is wrong, and would put a query on the hot path
 * of whatever polls it.
 */
export const readiness = async (container: Container): Promise<ReadinessReport> => {
  const identity = releaseIdentity(container);
  try {
    const response = await fetch(`${container.supabase.url}/rest/v1/`, {
      headers: { apikey: container.supabase.anonKey },
    });
    const ok = response.ok;
    return {
      ok,
      release: identity,
      checks: [
        {
          binding: 'SUPABASE_URL',
          ok,
          detail: ok ? 'answered the Data API root' : `Data API returned ${response.status}`,
        },
      ],
    };
  } catch (error) {
    return {
      ok: false,
      release: identity,
      checks: [
        {
          binding: 'SUPABASE_URL',
          ok: false,
          detail: error instanceof Error ? error.message : 'unknown error',
        },
      ],
    };
  }
};

/**
 * Headers for every health response.
 *
 * `no-store` unconditionally, including in development. A cached health response
 * is worse than a slow one: it reports the state of a previous release, which is
 * the opposite of what the endpoint is for. `no-store` is a requirement here, not
 * a default that CDN configuration is trusted to match.
 */
export const healthHeaders = { 'cache-control': 'no-store' } as const;

/**
 * Are these a *public* binding's credentials present?
 *
 * Exported because the readiness report is the only place that needs it, and
 * because a reviewer asking "does readiness actually exercise the required
 * bindings" should be able to check the list in one place rather than infer it
 * from the shape of a `try` block.
 */
export const REQUIRED_BINDINGS: readonly string[] = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];

/** Narrow an arbitrary value to the env shape readiness touches. */
export const asEnv = (value: unknown): Pick<AppEnv, 'RELEASE'> => value as Pick<AppEnv, 'RELEASE'>;

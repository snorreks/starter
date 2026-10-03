// apps/frontend/client/src/lib/server/container.ts
//
// Bindings, the database handle and the auth instance — scoped to the binding set
// and public origin they belong to.
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
//     * bindings / db / auth  -> a container, memoized per (binding set, origin, local run)
//     * user identity / trace -> built fresh for every request, in
//                                `buildRequestContext`, from the request itself
//
//   The memo is a `WeakMap` keyed on the `env` object rather than a module
//   variable, so there is no mutable module state at all: if the isolate is torn
//   down, the container goes with it and cannot outlive its bindings.
//
//   The origin is part of the key because the auth instance's `baseURL` is. In a
//   deployed environment there is exactly one origin per binding set, so the
//   second key level never holds more than one entry. Locally it is the origin
//   the request arrived on, which is the whole point of serving HTML, API and
//   cookies from one origin — a container is never shared between two origins.

import { type BetterAuthInstance, createBetterAuth } from '@starter/auth';
import {
  accounts,
  createD1RateLimitStorage,
  deviceCodes,
  sessions,
  users,
} from '@starter/database';

import { type DrizzleD1Database, drizzle } from 'drizzle-orm/d1';
import { type CaptureMailService, createCaptureMailService } from './email/capture_transport.ts';
import { type MailService, resolveMail } from './email/mail.ts';
import { createResendMailService } from './email/resend_transport.ts';
import {
  type AppEnv,
  type DeploymentEnvName,
  type JobsProfileName,
  requireBindings,
  resolveAuthRateLimitIngress,
  resolveAuthSecret,
  resolveDeploymentEnvironment,
  resolveJobsProfile,
  resolveRateLimitBudget,
  resolveTrustedOrigins,
} from './env.ts';
import { createArtifactReader, createDispatchPort } from './jobs_bindings.ts';
import { createJobsService, JOBS_PROFILE_ENCODE, type JobsService } from './jobs_service.ts';

/**
 * The tables this application exposes through Drizzle.
 *
 * A `type`, not an `interface`, on purpose: `DrizzleD1Database<T>` constrains T to
 * `Record<string, unknown>`, and an interface has no implicit index signature, so an
 * interface here fails to typecheck.
 *
 * Exported because the database handle is shared and its type has to be named in
 * more than one place. Declaring a second, narrower schema in a service does not
 * work: `DrizzleD1Database` is invariant in its schema parameter, so a handle built
 * for the full set is not assignable to one built for `{ notes }`. That is a real
 * constraint, not a compiler quirk — naming the app's schema once is also what stops
 * two services disagreeing about which tables exist.
 */
export type AppSchema = {
  users: typeof users;
  sessions: typeof sessions;
  accounts: typeof accounts;
  deviceCodes: typeof deviceCodes;
};

export interface Container {
  env: AppEnv;
  db: DrizzleD1Database<AppSchema>;
  auth: BetterAuthInstance;
  /** Resolved, validated deployment environment name. */
  environment: DeploymentEnvName;
  /** True only when `DEPLOYMENT_ENV` explicitly names a local environment. */
  isLocal: boolean;
  /** The public origin this container answers on. */
  baseUrl: string;
  /** Required transactional mail transport. */
  mail: MailService;
  /**
   * Present only in capture mode. Callers must check for an inbox before reading
   * it; deployed environments deliver mail and have no capture service.
   */
  mailCapture?: CaptureMailService;
  /**
   * The jobs service, including its resolved capability.
   *
   * Present even when the profile is `disabled`, so a route can answer
   * `503 jobs_profile_disabled` instead of having to know whether the capability
   * exists. That is the difference between "this deployment cannot do that" and a
   * 404 that reads like a wrong URL.
   */
  jobs: JobsService;
  /** Resolved jobs capability. `disabled` unless `JOBS_PROFILE` says otherwise. */
  jobsProfile: JobsProfileName;
}

/**
 * Where a followed verification link lands.
 *
 * Duplicated as a string rather than imported from the route, because
 * `container.ts` is built for workerd and must not pull in a `$types` module that only
 * exists after `svelte-kit sync`. `worker_integration.test.ts` asserts this route
 * renders, which is what keeps the two from drifting apart silently.
 */
export const VERIFICATION_CALLBACK_PATH = '/verify-email';

/**
 * Where a user approves a native client.
 *
 * Named here, and handed to `@starter/auth`, because the alternative is a plugin
 * default of `/device` that happens to match a route nobody promised to keep. When
 * the route and the advertised URL drift apart, a native client opens a 404 and
 * reports "sign-in failed" with nothing to act on. `worker_integration.test.ts`
 * asserts this route renders, which is what keeps the two in step.
 */
export const DEVICE_VERIFICATION_PATH = '/device';

const containers = new WeakMap<AppEnv, Map<string, Container>>();

/**
 * The container for a binding set, origin and local run. Built once per isolate.
 * The run id participates in the key so a new run cannot reuse a stale inbox.
 *
 * The auth instance is created here rather than per request: Better Auth is
 * expensive to construct and is stateless with respect to a request.
 *
 * Note that `DEPLOYMENT_ENV` is not validated at module load, so a misconfigured
 * deployment fails on the first request rather than when the bundle is imported.
 * That is deliberate and is the only correct place for it: this is where `env`
 * first exists.
 */
export const getContainer = (rawEnv: unknown, requestOrigin?: string): Container => {
  const env = requireBindings(rawEnv);

  // Resolved before the memo lookup, so a container is only ever reused for the
  // origin it was built with. `resolveDeploymentEnvironment` is pure, so calling
  // it on a cache hit costs a string comparison and no I/O.
  const resolved = resolveDeploymentEnvironment(env, requestOrigin);
  if (!resolved.ok) {
    throw new Error(`Refusing to start: ${resolved.problem}\n\n${resolved.remedy}`);
  }

  const { environment, isLocal, baseUrl } = resolved;

  const cacheKey = JSON.stringify([baseUrl, isLocal ? (env.TEST_RUN_ID?.trim() ?? 'local') : null]);
  const byOrigin = containers.get(env);
  const existing = byOrigin?.get(cacheKey);
  if (existing !== undefined) {
    return existing;
  }

  const db = drizzle(env.DB, { schema: { users, sessions, accounts, deviceCodes } });

  // Mail before auth, because an auth instance without a mailer cannot verify
  // anybody. A refusal here is the whole point: a deployed Worker with no
  // transport would accept sign-ups, report them as successful, and deliver
  // nothing to anyone.
  const mail = resolveMail(env, isLocal);
  if (!mail.ok) {
    throw new Error(`Refusing to start: ${mail.problem}\n\n${mail.remedy}`);
  }
  const mailService: MailService =
    mail.mode === 'capture'
      ? createCaptureMailService({ isLocal, inboxId: mail.inbox, from: mail.from })
      : createResendMailService({ apiKey: mail.apiKey ?? '', from: mail.from });

  const budget = resolveRateLimitBudget(env);
  const ingress = resolveAuthRateLimitIngress(env, isLocal);

  // Resolved before the literal, because both the service and the container's own
  // `jobsProfile` field need it. An unrecognised value throws here, which refuses
  // the container the same way a missing auth secret does — rather than surfacing as
  // a 500 on the first jobs request while notes and auth carry on.
  const jobsProfile = resolveJobsProfile(env);

  const container: Container = {
    env,
    db,
    environment,
    isLocal,
    baseUrl,
    mail: mailService,
    jobsProfile,
    // No dispatch port and no artifact reader are passed, so this is the disabled
    // implementation of each until PR H supplies the real ones. That is the honest
    // configuration for this PR: `createJobsService` refuses rather than pretending,
    // and the binding — not the Drizzle handle — is passed because the repository's
    // statements are hand-written SQL and Drizzle would only be a second name for
    // the same connection.
    // The dispatch port and the artifact reader are passed whenever the profile is
    // `encode`, and are omitted otherwise.
    //
    // Two reasons for that shape rather than "always pass them":
    //
    //   * a deployment with the profile disabled has no jobs Worker bound, so
    //     `ENCODE_WORKFLOW` is absent and passing `undefined` would build a port that
    //     refuses with `workflow_binding_missing` — a wrong reason for a profile that
    //     is off on purpose. The disabled port's own refusal is the accurate one;
    //   * the bucket is the same absence: with no compute there are no artifacts to
    //     read, and `readOutput` already has a refusal for "no store bound".
    //
    // What is *not* conditional is the wiring itself. The moment this deployment says
    // `JOBS_PROFILE=encode`, the two adapters are live and a job admitted by
    // `POST /api/jobs` starts a real Workflow instance — no second code path to
    // remember to switch on.
    jobs: createJobsService({
      db: env.DB,
      profile: jobsProfile,
      ...(jobsProfile === JOBS_PROFILE_ENCODE
        ? {
            dispatch: createDispatchPort(env.ENCODE_WORKFLOW),
            ...(env.MEDIA === undefined ? {} : { reader: createArtifactReader(env.MEDIA) }),
          }
        : {}),
    }),
    ...(mail.mode === 'capture' ? { mailCapture: mailService as CaptureMailService } : {}),
    auth: createBetterAuth(db, {
      baseURL: baseUrl,
      secret: resolveAuthSecret(env, isLocal),
      trustedOrigins: resolveTrustedOrigins(env, baseUrl, isLocal),
      // The atomic, database-backed counter. Built here rather than inside
      // `@starter/auth` so the D1 binding is reached in exactly one place.
      rateLimitStorage: createD1RateLimitStorage(env.DB),
      rateLimitMax: budget.max,
      rateLimitWindow: budget.window,
      ipAddressHeaders: ingress.headers,
      ...(ingress.trustedProxies.length === 0 ? {} : { trustedProxies: ingress.trustedProxies }),
      mailer: mailService,
      // Named from the route that exists, so the link and the page it lands on
      // cannot drift apart. Better Auth would otherwise default `callbackURL` to `/`
      // and drop a confirmed user on the public landing page.
      verificationCallbackPath: VERIFICATION_CALLBACK_PATH,
      // The URL a native client hands to the system browser. See above.
      deviceVerificationPath: DEVICE_VERIFICATION_PATH,
    }),
  };

  if (byOrigin === undefined) {
    containers.set(env, new Map([[cacheKey, container]]));
  } else {
    byOrigin.set(cacheKey, container);
  }
  return container;
};

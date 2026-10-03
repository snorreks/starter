// apps/backend/jobs/src/env.ts
//
// The jobs Worker's binding set, and the two resolutions that can refuse it.
//
// Refuse, not default
// -------------------
// A Worker with a missing binding does not get a substitute. `requireJobsBindings`
// throws naming the binding and the file that declares it, because the failure a
// half-configured jobs Worker produces otherwise is subtle: a missing R2 binding
// makes every encode fail at the last step, after the container has already
// spent its time and its money.
//
// The jobs profile
// ----------------
// `JOBS_PROFILE` decides whether this deployment may encode at all, and it is the
// *same* variable the web Worker reads. Both halves of one capability being named
// by one variable is what makes "the profile is on" a fact rather than two
// independent switches somebody has to keep in step.
//
// Absence means `disabled`. A deploy that forgot the variable must not acquire a
// paid compute path, and a deploy that mistyped it must say so rather than
// falling back to the value it recognises.
//
// Deployment environment
// ----------------------
// `DEPLOYMENT_ENV` is required and is the only thing that decides locality — the
// same rule, and for the same reason, as in the web app: it is the value a
// misconfigured deploy is most likely to be missing.

import type { WorkflowInstanceBinding } from '@starter/jobs';

/** `disabled` | `encode`. Mirrors the web Worker's `JOBS_PROFILE`. */
export const JOBS_PROFILE_DISABLED = 'disabled';
export const JOBS_PROFILE_ENCODE = 'encode';
export const JOBS_PROFILE_NAMES = [JOBS_PROFILE_DISABLED, JOBS_PROFILE_ENCODE] as const;
export type JobsProfileName = (typeof JOBS_PROFILE_NAMES)[number];

/** The port the media container listens on. Fixed by its Dockerfile's `EXPOSE`. */
export const MEDIA_CONTAINER_PORT = 8080;

/**
 * The bindings this Worker requires.
 *
 * `ENCODE_WORKFLOW` and `MAINTENANCE_WORKFLOW` are typed structurally, as
 * `@starter/jobs` declares them, rather than as the platform's `Workflow` type.
 * The structural type is the whole reason `createWorkflowDispatchPort` can be
 * tested under Bun and used here, and the two shapes are the same object.
 *
 * `PROCESSOR_ORIGIN` is optional on purpose and is *not* a test hook: it is how a
 * deployment reaches a processor that is not a Cloudflare Container of this
 * Worker — a self-hosted FFmpeg host, or the local compute lane's Docker
 * container. The default and documented production path is `ctx.container`, and
 * this binding is what makes "provider calls stay behind a narrow service port"
 * literally true for both.
 */
export interface JobsEnv {
  /** The shared, environment-isolated D1 database. */
  readonly DB: D1Database;
  /** Private R2: named fixtures and encoded artifacts. Never public. */
  readonly MEDIA: R2Bucket;
  readonly ENCODE_WORKFLOW: WorkflowInstanceBinding;
  readonly MAINTENANCE_WORKFLOW: WorkflowInstanceBinding;
  /** One Durable Object per job; the only component that may reach the container. */
  readonly CONTAINER: DurableObjectNamespace;
  readonly DEPLOYMENT_ENV?: string;
  readonly JOBS_PROFILE?: string;
  /** `http://host:port` of a processor this Worker does not run itself. */
  readonly PROCESSOR_ORIGIN?: string;
  /** The revision this deployment is. Reported by nothing here; recorded by the deploy log. */
  readonly RELEASE?: string;
}

/** The profile resolution, and the reason it refused. */
export type ProfileResolution =
  | { ok: true; profile: JobsProfileName }
  | { ok: false; problem: string; remedy: string };

/**
 * Which compute capability this deployment has.
 *
 * Fail-closed, and the failure names both the accepted values and the fix. An
 * unrecognised value is a configuration error rather than a default in either
 * direction: silently choosing `disabled` hides a typo behind a 503, and
 * silently choosing `encode` spends money on a typo.
 */
export const resolveJobsProfile = (env: { JOBS_PROFILE?: string }): ProfileResolution => {
  const raw = env.JOBS_PROFILE?.trim();
  if (raw === undefined || raw.length === 0) {
    return { ok: true, profile: JOBS_PROFILE_DISABLED };
  }
  const match = JOBS_PROFILE_NAMES.find((name) => name === raw);
  if (match === undefined) {
    return {
      ok: false,
      problem: `JOBS_PROFILE is "${raw}", which is not one of ${JOBS_PROFILE_NAMES.join(', ')}.`,
      remedy: 'Set JOBS_PROFILE to "encode" in the deployment that has the jobs Worker bound.',
    };
  }
  return { ok: true, profile: match };
};

const REQUIRED_BINDINGS = ['DB', 'MEDIA', 'ENCODE_WORKFLOW', 'MAINTENANCE_WORKFLOW', 'CONTAINER'];

/**
 * Narrow an unknown platform value to the binding set this Worker needs.
 *
 * The message names `wrangler.jsonc` because that is where the declaration is,
 * and it lists *every* missing binding rather than the first one — a Worker
 * deployed with one missing binding otherwise fails the same way after the next
 * fix, once per deploy.
 */
export const requireJobsBindings = (raw: unknown): JobsEnv => {
  const candidate = raw as Partial<JobsEnv> | undefined;
  if (candidate === undefined || candidate === null) {
    throw new Error(
      `The jobs Worker received no bindings. Declared in apps/backend/jobs/wrangler.jsonc.`,
    );
  }
  const missing = REQUIRED_BINDINGS.filter(
    (name) => candidate[name as keyof JobsEnv] === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `The jobs Worker is missing its bindings: ${missing.join(', ')}.\n` +
        '  They are declared in apps/backend/jobs/wrangler.jsonc. Nothing here has a\n' +
        '  substitute binding and nothing is defaulted: a Worker that cannot reach D1 or\n' +
        '  R2 must refuse rather than encode into nowhere.',
    );
  }
  return candidate as JobsEnv;
};

/**
 * The base URL of a processor reached without a container.
 *
 * Validated rather than used verbatim: this string ends up as the target of every
 * encode request, so a value without a scheme or with a path is a configuration
 * error worth naming at start-up instead of an obscure fetch failure 120 seconds
 * into an attempt.
 */
export const resolveProcessorOrigin = (
  raw: string | undefined,
): { ok: true; origin: string } | { ok: false; problem: string } => {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return { ok: true, origin: '' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      problem: `PROCESSOR_ORIGIN is "${trimmed}", which is not a URL.`,
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      ok: false,
      problem: `PROCESSOR_ORIGIN must be http or https, and it is "${parsed.protocol}".`,
    };
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    return {
      ok: false,
      problem: `PROCESSOR_ORIGIN must be an origin with no path, and it is "${parsed.pathname}".`,
    };
  }
  return { ok: true, origin: parsed.origin };
};

export type { WorkflowInstanceBinding };

// apps/frontend/client/src/lib/server/env.ts
//
// Worker bindings and deployment-environment policy.
//
// This is server-only. It is reached from `src/lib/server/**` and from route
// adapters, never from a component, a ViewModel or a client service.
//
// Read from the request-scoped bindings, never from a module-level variable. A
// module-level `let env` looks equivalent and is not: a Worker isolate serves
// many requests, and a value cached in module scope survives a request that
// changed it. The failure is rare, non-reproducible, and looks like a bug in the
// business logic. See `container.ts`.
//
// How these values reach the app: `@sveltejs/adapter-cloudflare` gives every
// request a `cloudflare:workers` module whose `env` is the Worker's binding set
// in production, and the local emulated binding set in `vite dev`/`vite
// preview` (read from `wrangler.jsonc`, Postgres included). That module throws if a
// prerenderable route touches it, which is the platform's own statement that
// build-time code must not need live bindings — so nothing here has to guess
// whether a binding exists.

import type { WorkflowInstanceBinding } from '@starter/jobs';

export const JOBS_PROFILE_DISABLED = 'disabled';
export const JOBS_PROFILE_ENCODE = 'encode';

/** The Worker bindings this application requires. */
export interface AppEnv {
  /** Public Supabase project URL. */
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  SUPABASE_MAIL_URL?: string;
  /**
   * Which deployment this is. Required, and the *only* input that decides whether
   * development defaults are permitted.
   *
   * Why this exists: an earlier rule inferred locality from the shape of
   * `APP_ORIGIN` — absent, or containing the substring `localhost` — and
   * `APP_ORIGIN` is exactly the value a misconfigured deploy is most likely
   * to be missing. A Worker deployed without that binding was therefore classified
   * local, which relaxed the auth-secret rule and started it with the development
   * secret. `evil-localhost.attacker.example` also satisfied the check. Both are
   * configuration-safety defects, not theoretical ones: the failure mode is a
   * remote deployment running with a publicly known session secret.
   *
   * Absence is an error, not a default.
   */
  DEPLOYMENT_ENV?: string;
  /**
   * Public base URL of this application.
   *
   * Required in a deployed environment. Optional in a local one, where it
   * defaults to the origin the request arrived on — see
   * `resolveDeploymentEnvironment`. One origin serves the HTML, the API and the
   * session cookie now, so the request's own origin is the correct answer rather
   * than a value that has to be kept in step with whichever port the dev server
   * happened to bind.
   */
  APP_ORIGIN?: string;
  /**
   * Identity a test harness passes in and /api/health echoes back, so the harness
   * can prove it reached this app rather than a stale listener.
   */
  TEST_RUN_ID?: string;
  /**
   * Sign-in attempts allowed per minute per IP.
   *
   * Parsed and validated by `resolveRateLimitBudget`, not by `Number()` at the
   * call site. `Number('ten')` is `NaN`, and `NaN` flowing into a limit is a
   * limit nobody can reason about — `NaN < max` is false for every request, so
   * the symptom would be either "everything is limited" or "nothing is",
   * depending on which comparison Supabase Auth happens to reach first.
   */
  /**
   * Resend API key. Required in a deployed environment; see `resolveMail`.
   *
   * Never logged, never returned by an endpoint, and never part of a readiness
   * report — only its *presence* is observable.
   */
  RESEND_API_KEY?: string;
  /**
   * Sender address for transactional mail. Required alongside `RESEND_API_KEY`.
   *
   * Not a secret, but not published either: it identifies the deployment to the
   * public.
   */
  MAIL_FROM?: string;
  /** Minimum level a log event must meet to be stored. */
  LOG_LEVEL?: string;
  /** Build identifier attached to every log event. Injected by the deploy step. */
  RELEASE?: string;
  /**
   * Which jobs capability this deployment has: `disabled` or `encode`.
   *
   * Required explicitly so disabled compute cannot be confused with missing setup.
   */
  JOBS_PROFILE?: string;
  /**
   * The encode Workflow in the jobs Worker. Present only where the jobs profile is
   * enabled and the cross-Worker binding is configured; absent is a refusal the
   * dispatch port names, not a silent no-op.
   */
  ENCODE_WORKFLOW?: WorkflowInstanceBinding;
  /**
   * The private artifact bucket, shared with the jobs Worker. Absent where the
   * profile is disabled, because nothing writes to it then.
   */
  MEDIA?: R2Bucket;
  RUNNER_GRANT_SECRET?: string;
  GOOGLE_RUNNER_AUDIENCE?: string;
  GOOGLE_RUNNER_SERVICE_ACCOUNT?: string;
  GOOGLE_RUNNER_SUBJECT?: string;
  GOOGLE_CLOUD_PROJECT?: string;
  GOOGLE_CLOUD_REGION?: string;
  GOOGLE_CLOUD_RUN_JOB?: string;
  GOOGLE_DISPATCHER_CREDENTIAL?: string;
  COMPUTE_PROTOCOL?: string;
  /**
   * Workers AI. Present only where `CHAT_MODEL_PROFILE=workers-ai` and the binding
   * is declared; absent is a refusal `createWorkersAiChatModel` names, not a
   * silent fallback to the local model.
   */
  AI?: unknown;
  /**
   * Which chat model this deployment has: absent (the local `echo` model),
   * `echo`, or `workers-ai`.
   *
   * Absent means `echo`, and that default is the point: it is the only profile
   * needing neither a binding nor a credential, so a fresh clone runs the whole
   * streaming path with no configuration. The inverse default would be the one
   * that spends money.
   */
  CHAT_MODEL_PROFILE?: string;
}

/** Require the public and administrative bindings used by the sole backend. */
export const requireSupabaseConfig = (
  env: Pick<AppEnv, 'SUPABASE_URL' | 'SUPABASE_ANON_KEY' | 'SUPABASE_SERVICE_ROLE_KEY'>,
): void => {
  const missing = [
    ['SUPABASE_URL', env.SUPABASE_URL],
    ['SUPABASE_ANON_KEY', env.SUPABASE_ANON_KEY],
    ['SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY],
  ]
    .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`Supabase configuration is incomplete: ${missing.join(', ')}.`);
  }
};

/** Values of `DEPLOYMENT_ENV` that permit development defaults. */
export const LOCAL_ENVIRONMENTS = new Set(['local', 'development']);

/** Every value `DEPLOYMENT_ENV` is allowed to take. Anything else is a config error. */
export const DEPLOYMENT_ENVIRONMENTS = ['local', 'development', 'staging', 'production'] as const;
export type DeploymentEnvName = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

/** Which jobs capability this deployment has. Mirrors `JOBS_PROFILE`. */
export const JOBS_PROFILE_NAMES = [JOBS_PROFILE_DISABLED, JOBS_PROFILE_ENCODE] as const;
export type JobsProfileName = (typeof JOBS_PROFILE_NAMES)[number];

/** Hostnames that are unambiguously this machine. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export type EnvironmentResolution =
  | { ok: true; environment: DeploymentEnvName; isLocal: boolean; baseUrl: string }
  | { ok: false; problem: string; remedy: string };

/**
 * Decide which environment this is, and what public origin it answers on.
 *
 * Fails closed in every ambiguous case:
 *   * `DEPLOYMENT_ENV` absent -> error, not "local"
 *   * `DEPLOYMENT_ENV` unrecognised -> error, not "local"
 *   * remote without `APP_ORIGIN` -> error
 *   * remote whose `APP_ORIGIN` is not a structurally valid https URL -> error
 *   * local without `APP_ORIGIN` -> the request's own origin, but only if that
 *     origin is loopback
 *
 * The last rule is the one that changed when the API and the client became one
 * application. Deriving the origin from the request is safe *here* precisely
 * because locality is still never derived from a URL: `DEPLOYMENT_ENV` had to be
 * set explicitly, and the substituted value has to be a loopback address, which a
 * deployed Worker answering on a public hostname cannot satisfy. Without the
 * loopback check, a deployment left on `DEPLOYMENT_ENV=local` would hand its
 * Supabase Auth configuration to whatever origin reached it.
 *
 * Note what this function does *not* do: it never inspects a hostname to decide
 * locality. `localhost` is a legitimate host for a local run and an illegitimate
 * one for a remote run, and no amount of string matching distinguishes "the
 * operator meant local" from "someone deployed with the wrong value".
 */
export const resolveDeploymentEnvironment = (
  env: { DEPLOYMENT_ENV?: string; APP_ORIGIN?: string },
  requestOrigin?: string,
): EnvironmentResolution => {
  const raw = env.DEPLOYMENT_ENV?.trim();

  if (raw === undefined || raw.length === 0) {
    return {
      ok: false,
      problem:
        'DEPLOYMENT_ENV is not set, so this deployment cannot be classified as local or remote.',
      remedy:
        'Set it explicitly. `wrangler dev` and `vite dev` both read wrangler.jsonc, whose ' +
        '`vars.DEPLOYMENT_ENV` is `local`. A deployed Worker needs it in wrangler.jsonc vars or ' +
        'as a secret, set to `staging` or `production`. Refusing to start is the point: a ' +
        'missing value used to be read as "local", which permitted the development auth secret ' +
        'remotely.',
    };
  }

  if (!(DEPLOYMENT_ENVIRONMENTS as readonly string[]).includes(raw)) {
    return {
      ok: false,
      problem: `DEPLOYMENT_ENV is "${raw}", which is not a known environment.`,
      remedy: `Valid values: ${DEPLOYMENT_ENVIRONMENTS.join(', ')}.`,
    };
  }

  const environment = raw as DeploymentEnvName;
  const isLocal = LOCAL_ENVIRONMENTS.has(environment);

  const configured = env.APP_ORIGIN?.trim();

  if (configured === undefined || configured.length === 0) {
    if (!isLocal) {
      return {
        ok: false,
        problem: `APP_ORIGIN is not set (DEPLOYMENT_ENV=${environment}).`,
        remedy:
          'Every deployed environment needs it: it is the origin Supabase Auth issues cookies ' +
          'for and validates callbacks against. A local run may omit it and use its own origin.',
      };
    }

    const derived = requestOrigin === undefined ? null : parseAbsoluteHttpUrl(requestOrigin);
    if (derived === null || !derived.ok) {
      return {
        ok: false,
        problem: 'APP_ORIGIN is not set and this request did not carry a usable absolute origin.',
        remedy:
          'Set APP_ORIGIN explicitly, or reach the local server on a loopback origin such ' +
          'as http://127.0.0.1:5173. Deriving it from the request is only permitted in a local ' +
          'environment and only for a loopback origin.',
      };
    }

    if (derived.url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(derived.url.hostname)) {
      return {
        ok: false,
        problem:
          `APP_ORIGIN is not set and the request origin ${derived.url.origin} is not a ` +
          'loopback http origin.',
        remedy:
          'Set APP_ORIGIN explicitly for anything that is not loopback. Deriving the public ' +
          'origin from an inbound request is a local-development convenience; a deployed ' +
          'environment must state its own origin rather than accept one from a caller.',
      };
    }

    return { ok: true, environment, isLocal, baseUrl: derived.url.origin };
  }

  const validated = parseAbsoluteHttpUrl(configured);
  if (!validated.ok) {
    return {
      ok: false,
      problem: `APP_ORIGIN is not a valid absolute http(s) URL: ${configured}`,
      remedy: validated.reason,
    };
  }

  if (!isLocal && validated.url.protocol !== 'https:') {
    return {
      ok: false,
      problem: `APP_ORIGIN must be https in ${environment}, got ${validated.url.protocol}//`,
      remedy:
        'A remote deployment reachable over plain http exposes session cookies and every ' +
        'credential in transit. If this really is a loopback-only local run, set ' +
        'DEPLOYMENT_ENV=local instead.',
    };
  }

  return { ok: true, environment, isLocal, baseUrl: validated.url.origin };
};

export type UrlValidation = { ok: true; url: URL } | { ok: false; reason: string };

/**
 * Structural URL validation.
 *
 * `new URL` alone accepts `not a url` in some shapes and, more importantly, a
 * string that merely *contains* `localhost` is not evidence of anything. This
 * requires an absolute http(s) URL with a hostname.
 */
export const parseAbsoluteHttpUrl = (value: string): UrlValidation => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'It must be an absolute URL, including the scheme.' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `The scheme must be http or https, not "${url.protocol}".` };
  }

  if (url.hostname.length === 0) {
    return { ok: false, reason: 'It must include a hostname.' };
  }

  return { ok: true, url };
};

/** Validate all mandatory Supabase bindings at the Worker boundary. */
export const requireBindings = (raw: unknown): AppEnv => {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Worker bindings are unavailable. Check apps/frontend/client/wrangler.jsonc.');
  }
  const candidate = raw as AppEnv;
  requireSupabaseConfig(candidate);
  const profile = resolveJobsProfile(candidate);
  if (profile === JOBS_PROFILE_ENCODE) {
    const missing = [
      ['ENCODE_WORKFLOW', candidate.ENCODE_WORKFLOW],
      ['MEDIA', candidate.MEDIA],
    ]
      .filter(([, value]) => value === undefined)
      .map(([name]) => name);
    if (missing.length) {
      throw new Error(`Enabled compute is missing required bindings: ${missing.join(', ')}.`);
    }
  }
  return candidate;
};

/**
 * Which jobs capability this deployment has.
 *
 * Fail-closed and explicit. An unrecognised or missing value is a configuration error,
 * for the same reason `resolveDeploymentEnvironment` refuses to infer anything from
 * a URL: a typo that silently disabled a feature reads as "the feature is broken",
 * and a typo that silently enabled one reads as "the feature works".
 */
export const resolveJobsProfile = (env: { JOBS_PROFILE?: string }): JobsProfileName => {
  const raw = env.JOBS_PROFILE?.trim();
  if (raw === undefined || raw.length === 0) {
    throw new Error('JOBS_PROFILE is not set. Set it explicitly to disabled or encode.');
  }
  if (raw === JOBS_PROFILE_DISABLED) {
    return JOBS_PROFILE_DISABLED;
  }
  if (raw === JOBS_PROFILE_ENCODE) {
    return JOBS_PROFILE_ENCODE;
  }
  throw new Error(
    `JOBS_PROFILE is "${raw}", which is not a known jobs profile. ` +
      `Valid values: ${JOBS_PROFILE_DISABLED}, ${JOBS_PROFILE_ENCODE}. ` +
      'Refusing to start: an unrecognised profile must not be guessed at.',
  );
};

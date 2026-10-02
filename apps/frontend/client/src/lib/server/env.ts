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
// preview` (read from `wrangler.jsonc`, D1 included). That module throws if a
// prerenderable route touches it, which is the platform's own statement that
// build-time code must not need live bindings — so nothing here has to guess
// whether a binding exists.

/** The Worker bindings this application requires. */
export interface AppEnv {
  /** D1 binding. Required: there is no in-memory store. */
  DB: D1Database;
  /**
   * Which deployment this is. Required, and the *only* input that decides whether
   * development defaults are permitted.
   *
   * Why this exists: an earlier rule inferred locality from the shape of
   * `BETTER_AUTH_URL` — absent, or containing the substring `localhost` — and
   * `BETTER_AUTH_URL` is exactly the value a misconfigured deploy is most likely
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
  BETTER_AUTH_URL?: string;
  /** Session signing secret. */
  BETTER_AUTH_SECRET?: string;
  /** Extra trusted origins, comma separated. */
  TRUSTED_ORIGINS?: string;
  /**
   * Identity a test harness passes in and /api/health echoes back, so the harness
   * can prove it reached this app rather than a stale listener.
   */
  TEST_RUN_ID?: string;
  /** Sign-in attempts allowed per minute per IP. Default 10. */
  AUTH_RATE_LIMIT_MAX?: string;
  /** Minimum level a log event must meet to be stored. */
  LOG_LEVEL?: string;
  /** Build identifier attached to every log event. Injected by the deploy step. */
  RELEASE?: string;
}

export const AUTH_SECRET_PLACEHOLDER = 'development-only-not-a-secret';

/** Values of `DEPLOYMENT_ENV` that permit development defaults. */
export const LOCAL_ENVIRONMENTS = new Set(['local', 'development']);

/** Every value `DEPLOYMENT_ENV` is allowed to take. Anything else is a config error. */
export const DEPLOYMENT_ENVIRONMENTS = ['local', 'development', 'staging', 'production'] as const;
export type DeploymentEnvName = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

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
 *   * remote without `BETTER_AUTH_URL` -> error
 *   * remote whose `BETTER_AUTH_URL` is not a structurally valid https URL -> error
 *   * local without `BETTER_AUTH_URL` -> the request's own origin, but only if that
 *     origin is loopback
 *
 * The last rule is the one that changed when the API and the client became one
 * application. Deriving the origin from the request is safe *here* precisely
 * because locality is still never derived from a URL: `DEPLOYMENT_ENV` had to be
 * set explicitly, and the substituted value has to be a loopback address, which a
 * deployed Worker answering on a public hostname cannot satisfy. Without the
 * loopback check, a deployment left on `DEPLOYMENT_ENV=local` would hand its
 * Better Auth configuration to whatever origin reached it.
 *
 * Note what this function does *not* do: it never inspects a hostname to decide
 * locality. `localhost` is a legitimate host for a local run and an illegitimate
 * one for a remote run, and no amount of string matching distinguishes "the
 * operator meant local" from "someone deployed with the wrong value".
 */
export const resolveDeploymentEnvironment = (
  env: { DEPLOYMENT_ENV?: string; BETTER_AUTH_URL?: string },
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

  const configured = env.BETTER_AUTH_URL?.trim();

  if (configured === undefined || configured.length === 0) {
    if (!isLocal) {
      return {
        ok: false,
        problem: `BETTER_AUTH_URL is not set (DEPLOYMENT_ENV=${environment}).`,
        remedy:
          'Every deployed environment needs it: it is the origin Better Auth issues cookies ' +
          'for and validates callbacks against. A local run may omit it and use its own origin.',
      };
    }

    const derived = requestOrigin === undefined ? null : parseAbsoluteHttpUrl(requestOrigin);
    if (derived === null || !derived.ok) {
      return {
        ok: false,
        problem:
          'BETTER_AUTH_URL is not set and this request did not carry a usable absolute origin.',
        remedy:
          'Set BETTER_AUTH_URL explicitly, or reach the local server on a loopback origin such ' +
          'as http://127.0.0.1:5173. Deriving it from the request is only permitted in a local ' +
          'environment and only for a loopback origin.',
      };
    }

    if (derived.url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(derived.url.hostname)) {
      return {
        ok: false,
        problem:
          `BETTER_AUTH_URL is not set and the request origin ${derived.url.origin} is not a ` +
          'loopback http origin.',
        remedy:
          'Set BETTER_AUTH_URL explicitly for anything that is not loopback. Deriving the public ' +
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
      problem: `BETTER_AUTH_URL is not a valid absolute http(s) URL: ${configured}`,
      remedy: validated.reason,
    };
  }

  if (!isLocal && validated.url.protocol !== 'https:') {
    return {
      ok: false,
      problem: `BETTER_AUTH_URL must be https in ${environment}, got ${validated.url.protocol}//`,
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

/**
 * Resolve the Better Auth secret.
 *
 * Fails closed when it cannot distinguish a real secret from the development one.
 *
 * The second check is the important one. Rejecting a *missing* secret is obvious.
 * Rejecting an *explicitly configured* secret that happens to be the shipped
 * development value is what stops `--var BETTER_AUTH_SECRET:development-only-not-a-secret`
 * from being a remote deployment's configuration.
 */
export const resolveAuthSecret = (env: AppEnv, isLocal: boolean): string => {
  const secret = env.BETTER_AUTH_SECRET?.trim();

  if (isLocal) {
    return secret !== undefined && secret.length > 0 ? secret : AUTH_SECRET_PLACEHOLDER;
  }

  if (secret === undefined || secret.length === 0) {
    throw new Error(
      'BETTER_AUTH_SECRET is not set. Refusing to start with a development secret. ' +
        'Set it with: wrangler secret put BETTER_AUTH_SECRET',
    );
  }

  if (secret === AUTH_SECRET_PLACEHOLDER) {
    throw new Error(
      'BETTER_AUTH_SECRET is the shipped development placeholder. Refusing to start. ' +
        'That value is in this repository, so a session signed with it is signed with ' +
        'something anybody can read. Set a real secret with: wrangler secret put BETTER_AUTH_SECRET',
    );
  }

  if (secret.length < 32) {
    throw new Error(
      'BETTER_AUTH_SECRET is shorter than 32 characters. Refusing to start: a short ' +
        'secret is brute-forceable regardless of where it is stored.',
    );
  }

  return secret;
};

/**
 * Narrow an unknown platform value to the bindings this app requires.
 *
 * Fail-closed by construction: a missing `DB` is a thrown error naming the
 * binding, not a default. The message names the file to edit, because the failure
 * a misconfigured deploy produces is otherwise an opaque 500.
 */
export const requireBindings = (raw: unknown): AppEnv => {
  const candidate = raw as AppEnv | undefined;
  if (candidate === undefined || candidate === null || candidate.DB === undefined) {
    throw new Error(
      'The D1 binding "DB" is not available. It is declared in ' +
        'apps/frontend/client/wrangler.jsonc; run `bun run db:migrate` for the local schema, ' +
        'and `bun run dev` for the local Worker runtime.',
    );
  }
  return candidate;
};

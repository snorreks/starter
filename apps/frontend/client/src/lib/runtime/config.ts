// apps/frontend/client/src/lib/runtime/config.ts
//
// Browser-side runtime configuration.
//
// One module resolves the API base URL, because getting it wrong is the single
// most common reason "it works locally but not when deployed". There is now a
// simpler answer than there was:
//
//   **the API is this origin.**
//
// The Worker serves the HTML, the assets and `/api/*` from one origin, in
// development and in production alike. A Vite proxy used to stand between a dev
// server on :5173 and a Worker on :8787, and every cookie, redirect and
// `Origin` check had to be arranged around that split. There is no split now, so
// a request is simply relative.
//
// `PUBLIC_API_BASE_URL` survives for one case: pointing a *browser* at a
// different deployment's API while debugging. It is not needed to run this
// application, and the default it falls back to is now `''` rather than
// `http://127.0.0.1:8787` — a loopback address that no longer exists in this
// architecture and would have silently sent every browser request to a port
// nothing was listening on.

export interface ClientConfig {
  /**
   * Absolute origin of the API, or `''` for "same origin, use relative URLs".
   *
   * `''` rather than `window.location.origin` on purpose: a relative URL keeps
   * the session cookie first-party without a `credentials` decision at the call
   * site, and it is correct during SSR, where there is no `window` at all.
   */
  apiBaseUrl: string;
  environment: 'local' | 'staging' | 'production';
  logLevel: 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR' | 'NONE';
  /** Build id, surfaced on every log event so a log can be tied to a commit. */
  release: string;
  /** Where the client forwards structured events, if it forwards at all. */
  telemetryEndpoint: string | undefined;
}

const readPublicEnv = (key: string): string | undefined => {
  const value = (import.meta.env as Record<string, string | undefined>)[key];
  return value && value.length > 0 ? value : undefined;
};

const readLogLevel = (raw: string | undefined): ClientConfig['logLevel'] => {
  switch (raw?.toUpperCase()) {
    case 'DEBUG':
    case 'INFO':
    case 'WARNING':
    case 'ERROR':
    case 'NONE':
      return raw.toUpperCase() as ClientConfig['logLevel'];
    default:
      return 'INFO';
  }
};

const readEnvironment = (raw: string | undefined): ClientConfig['environment'] => {
  switch (raw) {
    case 'staging':
    case 'production':
      return raw;
    default:
      return 'local';
  }
};

/**
 * The API origin, or `''` for same-origin.
 *
 * A trailing slash is stripped because `ApiClient` joins with `/`, and
 * `https://host//api/notes` is a different path to the one the server routes.
 */
const resolveApiBaseUrl = (): string => {
  const explicit = readPublicEnv('PUBLIC_API_BASE_URL');
  return explicit === undefined ? '' : explicit.replace(/\/$/, '');
};

export const clientConfig: ClientConfig = {
  apiBaseUrl: resolveApiBaseUrl(),
  environment: readEnvironment(readPublicEnv('PUBLIC_MODE')),
  logLevel: readLogLevel(readPublicEnv('PUBLIC_LOG_LEVEL')),
  release: readPublicEnv('PUBLIC_APP_VERSION') ?? 'dev',
  telemetryEndpoint: readPublicEnv('PUBLIC_TELEMETRY_ENDPOINT'),
};

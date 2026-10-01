// apps/frontend/client/src/lib/runtime/config.ts
//
// Runtime configuration.
//
// One module resolves the API base URL, because getting it wrong is the single
// most common reason "it works locally but not when deployed":
//
//   - browser dev  -> same origin, proxied by Vite to the local Worker
//   - server pass  -> no origin to be relative to, so the local Worker address
//   - deployed web -> PUBLIC_API_BASE_URL, or same origin

export interface ClientConfig {
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

const resolveApiBaseUrl = (): string => {
  const explicit = readPublicEnv('PUBLIC_API_BASE_URL');
  if (explicit) {
    return explicit.replace(/\/$/, '');
  }

  if (typeof window === 'undefined') {
    // Server/SSR render pass: there is no origin to be relative to.
    return `http://127.0.0.1:${readPublicEnv('PUBLIC_API_PORT') ?? '8787'}`;
  }

  // Browser: same origin, which the dev server proxies in development and the
  // static Worker serves in production.
  return window.location.origin;
};

export const clientConfig: ClientConfig = {
  apiBaseUrl: resolveApiBaseUrl(),
  environment: readEnvironment(readPublicEnv('PUBLIC_MODE')),
  logLevel: readLogLevel(readPublicEnv('PUBLIC_LOG_LEVEL')),
  release: readPublicEnv('PUBLIC_APP_VERSION') ?? 'dev',
  telemetryEndpoint: readPublicEnv('PUBLIC_TELEMETRY_ENDPOINT'),
};

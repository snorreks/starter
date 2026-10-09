// apps/frontend/native/src/lib/runtime/config.ts
//
// What this build believes about the API it talks to.
//
// Three values, and each one is validated rather than assumed:
//
//   apiOrigin  — the absolute origin of the deployed Worker. This app has no
//                server of its own (see `vite.config.ts`), so this string is the
//                difference between a working client and one that posts a bearer
//                token to whatever host happens to answer.
//   dev        — whether this bundle is a development build.
//
// Why the origin is validated rather than normalized
// ---------------------------------------------------
// Every way this can be wrong produces a *plausible* client. A missing
// production origin falls back to the loopback default and the app starts, then
// fails every request with a connection error. A `http://` production origin
// works until the first redirect, and then sends a bearer token in a cleartext
// request. A URL with a path in it (`https://host/api`) joins into
// `https://host/api/api/notes`, which 404s. None of these throw in a browser, so
// they are refused here, where the failure names the value that was wrong.
//
// The rule is deliberately asymmetric: development may use loopback over HTTP,
// production may not use HTTP at all. That asymmetry is the whole policy — a
// dev-only relaxation that is keyed on the build mode cannot survive into a
// packaged app, because the packaged app is not a dev build.

import { DEV_API_HOST_ENV, resolveApiOrigin } from '@starter/schemas/native';

export {
  DEFAULT_DEV_API_ORIGIN,
  DEV_API_HOST_ENV,
  NativeConfigError,
  resolveApiOrigin,
} from '@starter/schemas/native';

const readEnv = (key: string): string | undefined => {
  const value = (import.meta.env as Record<string, string | undefined>)[key];
  return value !== undefined && value.length > 0 ? value : undefined;
};

/**
 * Whether this bundle is a development build.
 *
 * Read from `import.meta.env.DEV`, which Vite replaces at build time, so it cannot
 * be turned on by an environment variable that survives into a release build.
 */
const isDevBuild = import.meta.env.DEV === true;

const requiredEnv = (key: string): string => {
  const value = readEnv(key);
  if (value === undefined) {
    throw new Error(`Native Supabase configuration requires ${key}.`);
  }
  return value;
};

const apiOrigin = resolveApiOrigin({
  raw: readEnv('VITE_NATIVE_API_ORIGIN'),
  dev: isDevBuild,
  devHost: isDevBuild ? readEnv(DEV_API_HOST_ENV) : undefined,
});

const supabaseUrl = requiredEnv('VITE_NATIVE_SUPABASE_URL');
{
  const parsed = new URL(supabaseUrl);
  if (
    parsed.protocol !== 'https:' &&
    !(isDevBuild && ['localhost', '127.0.0.1'].includes(parsed.hostname))
  ) {
    throw new Error('VITE_NATIVE_SUPABASE_URL must use HTTPS outside local development.');
  }
  if (
    parsed.origin !== supabaseUrl ||
    parsed.pathname !== '/' ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      'VITE_NATIVE_SUPABASE_URL must be an origin without a path, query, or fragment.',
    );
  }
}

const supabaseProjectRef = requiredEnv('VITE_NATIVE_SUPABASE_PROJECT_REF');
const supabaseAnonKey = requiredEnv('VITE_NATIVE_SUPABASE_ANON_KEY');
const environment = requiredEnv('VITE_NATIVE_ENVIRONMENT');
const nativeCallback = 'com.example.starter://auth/callback';
const webCallback = `${apiOrigin}/auth/callback`;

export interface NativeConfig {
  readonly apiOrigin: string;
  readonly dev: boolean;
  readonly environment: string;
  readonly supabaseUrl: string;
  readonly supabaseProjectRef: string;
  readonly supabaseAnonKey: string;
  readonly nativeCallback: string;
  readonly webCallback: string;
  readonly allowedCallbacks: readonly string[];
}

export const nativeConfig: NativeConfig = {
  apiOrigin,
  dev: isDevBuild,
  environment,
  supabaseUrl,
  supabaseProjectRef,
  supabaseAnonKey,
  nativeCallback,
  webCallback,
  allowedCallbacks: [nativeCallback, webCallback],
};

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
//   clientId   — the Better Auth device-authorization client identifier. Public:
//                it is compiled into the bundle and cannot be kept secret, and
//                treating a public identifier as a credential is how a template
//                grows a "universal client secret" nobody can rotate.
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

import { resolveApiOrigin, resolveClientId } from '@starter/schemas/native';

export {
  DEFAULT_CLIENT_ID,
  DEFAULT_DEV_API_ORIGIN,
  NativeConfigError,
  resolveApiOrigin,
  resolveClientId,
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

export interface NativeConfig {
  readonly apiOrigin: string;
  readonly clientId: string;
  readonly dev: boolean;
}

export const nativeConfig: NativeConfig = {
  apiOrigin: resolveApiOrigin({ raw: readEnv('VITE_NATIVE_API_ORIGIN'), dev: isDevBuild }),
  clientId: resolveClientId(readEnv('VITE_NATIVE_CLIENT_ID')),
  dev: isDevBuild,
};

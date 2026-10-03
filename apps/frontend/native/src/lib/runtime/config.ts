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

/** The API origin the development shell talks to when nothing is configured. */
export const DEFAULT_DEV_API_ORIGIN = 'http://127.0.0.1:5173';

/** The device-authorization client id, when the build does not override it. */
export const DEFAULT_CLIENT_ID = 'starter-native-desktop';

export class NativeConfigError extends Error {
  override readonly name = 'NativeConfigError';
}

/** Hosts a development build may reach over plain HTTP. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** A client id goes into a URL and into a database row. Bound both. */
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

export interface ResolveOriginOptions {
  /** The raw configured value. Unset or empty means "not configured". */
  readonly raw: string | undefined;
  /** True for a development build. */
  readonly dev: boolean;
}

/**
 * Resolve and validate the API origin.
 *
 * Throws rather than returning a fallback it is unsure about: this runs during
 * module evaluation, so a misconfigured bundle fails where the cause is visible
 * (the shell's stderr, naming the value) instead of producing a client that
 * looks fine and signs nobody in.
 */
export const resolveApiOrigin = ({ raw, dev }: ResolveOriginOptions): string => {
  const value = raw?.trim();

  if (value === undefined || value.length === 0) {
    if (dev) {
      return DEFAULT_DEV_API_ORIGIN;
    }
    throw new NativeConfigError(
      'No API origin is configured. Set VITE_NATIVE_API_ORIGIN to the absolute https ' +
        'origin of your deployed API before building the native client — there is no ' +
        'default for a packaged build, because guessing one produces a client that ' +
        'starts and then signs nobody in.',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new NativeConfigError(
      `VITE_NATIVE_API_ORIGIN="${value}" is not an absolute URL. It must include the ` +
        'scheme, e.g. https://api.example.com.',
    );
  }

  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new NativeConfigError(
      `VITE_NATIVE_API_ORIGIN="${value}" contains a path. Give the origin only: ` +
        'the client appends /api/* itself.',
    );
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new NativeConfigError(
      `VITE_NATIVE_API_ORIGIN="${value}" contains a query or a fragment. Give the ` +
        'origin only.',
    );
  }

  if (parsed.protocol !== 'https:') {
    const loopback = dev && parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname);
    if (!loopback) {
      throw new NativeConfigError(
        `VITE_NATIVE_API_ORIGIN="${value}" uses ${parsed.protocol}//. A packaged build ` +
          'presents a bearer token on every request, so the origin must be https. ' +
          (dev
            ? 'Plain http is allowed in development, and only to loopback.'
            : 'Development builds may use http://127.0.0.1.'),
      );
    }
  }

  // `origin` rather than the raw string: `new URL` has already lowercased the
  // host, dropped the default port and normalized an IPv6 literal, and this
  // value is used both as a URL prefix and as part of a session scope key.
  return parsed.origin;
};

/**
 * Resolve the device-authorization client id.
 *
 * Validated, not sanitized. A client id that would need escaping in a URL is a
 * configuration error worth refusing at build time, and the pattern is the same
 * shape Better Auth accepts for the field.
 */
export const resolveClientId = (raw: string | undefined): string => {
  const value = raw?.trim();
  if (value === undefined || value.length === 0) {
    return DEFAULT_CLIENT_ID;
  }
  if (!CLIENT_ID_PATTERN.test(value)) {
    throw new NativeConfigError(
      `VITE_NATIVE_CLIENT_ID="${value}" is not 1-64 characters of A-Z, a-z, 0-9, dot, ` +
        'underscore, colon or hyphen.',
    );
  }
  return value;
};

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

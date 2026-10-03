// Portable native configuration policy, shared by the launcher and frontend.

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

/** IPC endpoints are local to the shell; only one remote API origin is allowed. */
const LOCAL_CONNECTIONS = ["'self'", 'ipc:', 'http://ipc.localhost'];

export const assertNativeCsp = (csp: string, apiOrigin: string): void => {
  const directives = csp.split(';').map((value) => value.trim().split(/\s+/));
  const connections = directives.filter(([name]) => name === 'connect-src');
  const expected = new Set([...LOCAL_CONNECTIONS, apiOrigin]);
  const actual = connections[0]?.slice(1) ?? [];
  if (
    connections.length !== 1 ||
    actual.length !== expected.size ||
    actual.some((source) => !expected.has(source)) ||
    new Set(actual).size !== expected.size
  ) {
    throw new NativeConfigError('Native CSP connect-src and VITE_NATIVE_API_ORIGIN disagree.');
  }
};

export const nativeCsp = (base: string, apiOrigin: string): string => {
  const directives = base.split(';').map((value) => value.trim());
  const csp = [
    ...directives.filter((value) => value && !/^connect-src(?:\s|$)/.test(value)),
    `connect-src ${[...LOCAL_CONNECTIONS, apiOrigin].join(' ')}`,
  ].join('; ');
  assertNativeCsp(csp, apiOrigin);
  return csp;
};

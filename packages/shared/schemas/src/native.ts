// Portable native configuration policy, shared by the launcher and frontend.

/** The API origin the development shell talks to when nothing is configured. */
export const DEFAULT_DEV_API_ORIGIN = 'http://127.0.0.1:5173';

export class NativeConfigError extends Error {
  override readonly name = 'NativeConfigError';
}

/** Hosts a development build may reach over plain HTTP. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/**
 * A development host a *phone* can reach.
 *
 * A bare hostname or IP literal, deliberately narrower than the API-origin
 * grammar: this value is interpolated into a URL, and it must not be able to
 * carry a scheme, a port or a path. The port stays the one the developer
 * configured, because the phone and the machine are the same run and a second
 * port here is a second thing to keep in step.
 *
 * No requirement that it be a private range. The host is supplied by whoever
 * runs `native android dev --host …`, the alternative is refusing the address
 * their network actually handed them, and the value is only ever reachable in a
 * development build — see `resolveApiOrigin`.
 */
const DEV_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

/** The environment variable naming the development host a device should use. */
export const DEV_API_HOST_ENV = 'VITE_NATIVE_DEV_API_HOST';

export interface ResolveOriginOptions {
  /** The raw configured value. Unset or empty means "not configured". */
  readonly raw: string | undefined;
  /** True for a development build. */
  readonly dev: boolean;
  /**
   * The development machine's address on the network, for a physical phone.
   *
   * `localhost` on a phone is the phone. The Android emulator is the one case
   * where the host's loopback *is* reachable (it is forwarded to the host), and
   * the Tauri CLI knows that; a device on the same Wi-Fi is not, so the host has
   * to be named. Refused outside development — a packaged bundle compiled with
   * a LAN address points every user at one machine on one network.
   */
  readonly devHost?: string | undefined;
}

/**
 * Resolve and validate the API origin.
 *
 * Throws rather than returning a fallback it is unsure about: this runs during
 * module evaluation, so a misconfigured bundle fails where the cause is visible
 * (the shell's stderr, naming the value) instead of producing a client that
 * looks fine and signs nobody in.
 */
export const resolveApiOrigin = ({ raw, dev, devHost }: ResolveOriginOptions): string => {
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

  const declaredHost = devHost?.trim();
  const hasDeviceHost = declaredHost !== undefined && declaredHost.length > 0;

  if (hasDeviceHost) {
    if (!dev) {
      throw new NativeConfigError(
        `${DEV_API_HOST_ENV}="${declaredHost}" names a machine on one network. A packaged ` +
          'build baked with it would point every user at that machine. It is accepted ' +
          'only for `native android dev` / `native ios dev` against a development API.',
      );
    }
    if (
      declaredHost !== undefined &&
      (!DEV_HOST_PATTERN.test(declaredHost) || declaredHost.length > 253)
    ) {
      throw new NativeConfigError(
        `${DEV_API_HOST_ENV}="${declaredHost}" is not a bare host name or IP address. Give ` +
          'the host only — no scheme, port or path. The port stays the one in ' +
          'VITE_NATIVE_API_ORIGIN.',
      );
    }
    // The scheme is checked before the host is moved. `URL` accepts `file:`,
    // `ws:` and `data:`, and `origin` is `"null"` for the first two — so a
    // non-http origin would otherwise sail through a branch whose whole job is to
    // produce a reachable https/http origin.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new NativeConfigError(
        `VITE_NATIVE_API_ORIGIN="${value}" uses ${parsed.protocol}//. Only http and ` +
          'https are API origins, and this is the branch that would have returned ' +
          'whatever `URL.origin` produced for anything else.',
      );
    }
    // Rebuilt rather than string-replaced: `URL` refuses to move a host without
    // rewriting the default-port rule, and a hand-built string here is how a
    // device ends up pointed at `http://127.0.0.1:5173` with the host appended.
    const rebuilt = new URL(parsed.toString());
    rebuilt.hostname = declaredHost;
    return rebuilt.origin;
  }

  if (parsed.protocol !== 'https:') {
    /*
     * Plain HTTP is a development exception, and it is decided by `dev`, which
     * the caller derives from the subcommand rather than from the environment. A
     * user cannot flip it for a packaged build by exporting a variable: a
     * `native android build --debug` APK is `dev: false` and is refused here.
     *
     * Two development shapes are allowed, and neither is the other:
     *
     *   * loopback, for a desktop window or the Android emulator — the one case
     *     where the host's `127.0.0.1` really is reachable from the app;
     *   * nothing else. A plain-http LAN address is refused unless it was named
     *     through `--host`, which is above. That is the difference between "I told
     *     this build to reach my machine" and "somebody edited an environment
     *     variable", and a phone cannot be reached by accident over the network.
     */
    const loopback = LOOPBACK_HOSTS.has(parsed.hostname);
    const development = dev && parsed.protocol === 'http:' && loopback;
    if (!development) {
      throw new NativeConfigError(
        `VITE_NATIVE_API_ORIGIN="${value}" uses ${parsed.protocol}//. A packaged build ` +
          'presents a bearer token on every request, so the origin must be https.' +
          (dev
            ? ` Plain http is allowed in development, and only to loopback` +
              ` (${[...LOOPBACK_HOSTS].slice(0, 3).join(', ')}).` +
              ` A phone's ${parsed.hostname} is the phone, not your machine: pass ` +
              '`native android dev --host <address>` / `native ios dev --host <address>` ' +
              'to name the development host explicitly.'
            : ' Development builds may use http://127.0.0.1.'),
      );
    }
  }

  // `origin` rather than the raw string: `new URL` has already lowercased the
  // host, dropped the default port and normalized an IPv6 literal, and this
  // value is used both as a URL prefix and as part of a session scope key.
  return parsed.origin;
};

/** IPC endpoints are local to the shell; only one remote API origin is allowed. */
const LOCAL_CONNECTIONS = ["'self'", 'ipc:', 'http://ipc.localhost'];

export const assertNativeCsp = (
  csp: string,
  apiOrigin: string,
  additionalOrigins: readonly string[] = [],
): void => {
  const directives = csp.split(';').map((value) => value.trim().split(/\s+/));
  const connections = directives.filter(([name]) => name === 'connect-src');
  const expected = new Set([...LOCAL_CONNECTIONS, apiOrigin, ...additionalOrigins]);
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

export const nativeCsp = (
  base: string,
  apiOrigin: string,
  additionalOrigins: readonly string[] = [],
): string => {
  const directives = base.split(';').map((value) => value.trim());
  const csp = [
    ...directives.filter((value) => value && !/^connect-src(?:\s|$)/.test(value)),
    `connect-src ${[...LOCAL_CONNECTIONS, apiOrigin, ...additionalOrigins].join(' ')}`,
  ].join('; ');
  assertNativeCsp(csp, apiOrigin, additionalOrigins);
  return csp;
};

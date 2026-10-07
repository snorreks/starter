// apps/frontend/native/src/lib/platform/external_browser.ts
//
// Hand an approval URL to the user's own browser. Nothing else.
//
// This is the narrowest capability in the application, and it exists because the
// device-authorization flow needs one. The user approves a sign-in in a browser
// that already holds their account; a webview rendering that page instead would
// put the application's chrome around somebody's login form, which is a phishing
// surface and a credential-capture surface besides. The snapshot's launcher had
// the app open remote URLs in-app; that is not recovered here.
//
// Three refusals, each one closing a door:
//
//   * **Not https.** A `file://`, `tauri://` or `http://` URL is not something
//     this app has any reason to open. The opener plugin will happily hand any of
//     them to the OS, and the OS will happily act on it.
//   * **Not the API's own origin.** The URL comes from a *response body*. A
//     compromised or misconfigured provider that answered with
//     `https://elsewhere.test/…` would otherwise get the user to open a page in
//     their real browser, with a code in the query string, from this app.
//   * **Not without a shell.** Running `bun run native:dev` in a plain browser
//     has no Tauri API, and `openUrl` throws a string with no context. That is
//     reported as a named failure naming the command to run, not as a silent
//     no-op and not as a `window.open` fallback that would work in dev and fail in
//     the packaged app.

import type { ExternalBrowser } from '@starter/platform';
import { openUrl } from '@tauri-apps/plugin-opener';

export class ExternalBrowserRefused extends Error {
  override readonly name = 'ExternalBrowserRefused';
}

export interface ExternalBrowserOptions {
  /** The API origin whose URLs this client is allowed to hand to the OS. */
  readonly origin: string;
  /** Additional exact provider origins configured by the native host. */
  readonly allowedOrigins?: readonly string[];
  readonly allowLoopbackHttp?: boolean;
  /** Injected so a test can observe without a shell. */
  readonly open?: (url: string) => Promise<unknown>;
}

/**
 * Validate one URL against the allowance, or explain the refusal.
 *
 * Exported for the unit lane: this is the boundary a future screen could
 * accidentally widen, and widening it must fail a test rather than pass review.
 */
export const assertOpenable = (
  raw: string,
  origin: string,
  allowedOrigins: readonly string[] = [],
  allowLoopbackHttp = false,
): URL => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ExternalBrowserRefused(
      `"${raw}" is not an absolute URL, so there is nothing to open in a browser.`,
    );
  }

  const loopbackHttp =
    allowLoopbackHttp &&
    parsed.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !loopbackHttp) {
    throw new ExternalBrowserRefused(
      `Refusing to open ${parsed.protocol}//${parsed.host}. Only https is allowed.`,
    );
  }

  const allowed = new Set([
    new URL(origin).origin,
    ...allowedOrigins.map((value) => new URL(value).origin),
  ]);
  if (!allowed.has(parsed.origin)) {
    throw new ExternalBrowserRefused(
      `Refusing to open ${parsed.origin}: this client only hands configured provider and API origins ` +
        'to the system browser.',
    );
  }

  return parsed;
};

/**
 * The narrow external-browser capability.
 *
 * `withGlobalTauri` is false in `tauri.conf.json`, so the page cannot reach any
 * other native command from JavaScript: this closure is the entire surface, and
 * the capability file grants exactly the opener permission it needs.
 */
export const createExternalBrowser = (options: ExternalBrowserOptions): ExternalBrowser => ({
  open: async (url: string): Promise<void> => {
    assertOpenable(url, options.origin, options.allowedOrigins, options.allowLoopbackHttp);
    const open = options.open ?? ((target: string) => openUrl(target));
    try {
      await open(url);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ExternalBrowserRefused(
        `The system browser could not be opened (${detail}). This capability needs the ` +
          'native shell: run `bun run native:dev`, or `bun run native:build` and install ' +
          'the packaged app.',
      );
    }
  },
});

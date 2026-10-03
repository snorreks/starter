// packages/frontend/platform/src/capabilities.ts
//
// The two capabilities a feature needs from its host that are not HTTP.
//
// `Navigation` exists because "go to the workspace" is not a URL operation. In a
// browser it is SvelteKit's router, which re-runs the load against the session
// the browser already holds; in a native shell it is a router over static files
// that has no server load at all. A feature that imported `$app/navigation` could
// only ever be run by the first one.
//
// `ExternalBrowser` is separate rather than a flag on `Navigation` because the two
// are not interchangeable. An approval link must leave the app: it is the user's
// own browser that holds the account, and a webview showing a provider's login
// page is a phishing surface with the app's chrome around it. Naming them apart
// means a feature asks for what it means.

/** Move the host to an application path. Never a full URL. */
export interface Navigation {
  go(path: string): Promise<void> | void;
}

/**
 * Hand a URL to the user's own browser.
 *
 * `url` is expected to be absolute and is the caller's responsibility: refusing
 * one here would mean deciding what a host considers safe to open, which is the
 * shell's policy and not this package's.
 */
export interface ExternalBrowser {
  open(url: string): Promise<void>;
}

// packages/frontend/services/src/platform/host.ts
//
// Which host are we running in?
//
// Detected once and exported as a value rather than re-derived at each call
// site. The distinction matters: a Tauri webview is `http(s)://tauri.localhost`
// on Windows and `tauri://localhost` elsewhere, so a naive `isLocalhost` check
// reports a native build as a browser — which then tries to use `fetch` with
// cookies against a cross-site API and fails in a way that looks like a bug in
// the API.

export type HostPlatform = 'browser' | 'tauri' | 'unknown';

declare const __TAURI_INTERNALS__: unknown;

/** Present only inside a Tauri webview. Set by the Tauri runtime, not by us. */
export const isTauri = (): boolean =>
  typeof __TAURI_INTERNALS__ !== 'undefined' || '__TAURI_INTERNALS__' in globalThis;

export const detectHostPlatform = (): HostPlatform => {
  if (isTauri()) {
    return 'tauri';
  }
  if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
    return 'browser';
  }
  return 'unknown';
};

/**
 * True for the Tauri webview's origins.
 *
 * Re-exported from `@starter/schemas` rather than re-implemented: the API has to
 * make the same judgement, and two copies of an origin regex drift.
 */
export { isTauriWebviewOrigin, TAURI_WEBVIEW_ORIGINS } from '@starter/schemas/registry';

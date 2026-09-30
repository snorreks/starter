// packages/shared/schemas/src/registry/origins.ts
//
// Origin policy, shared by both planes.
//
// This lives in `@starter/schemas` rather than in either plane because the
// client and the API must agree on it exactly. A browser list in the frontend
// and a separate list in the Worker is how a native client ends up rejected by
// CORS in one direction and by Better Auth's origin check in the other — a
// failure that presents as "sign-in works on the web, does nothing in Tauri".

/**
 * Origins a Tauri webview presents on its requests.
 *
 * `tauri://localhost` on Linux and macOS, `http(s)://tauri.localhost` on
 * Windows. Listed explicitly rather than as a `localhost` wildcard: a plain
 * browser on localhost must gain nothing from the native client's allowance.
 */
export const TAURI_WEBVIEW_ORIGINS = [
  'tauri://localhost',
  'http://tauri.localhost',
  'https://tauri.localhost',
] as const;

const TAURI_ORIGIN_PATTERN = /^(tauri|https?):\/\/(localhost|tauri\.localhost)$/i;

export const isTauriWebviewOrigin = (origin: string): boolean => TAURI_ORIGIN_PATTERN.test(origin);

/**
 * Whether a browser origin may make credentialed requests to this API.
 *
 * Allowlist only. A prefix or suffix match is not enough: `evil-example.com`
 * passes an `endsWith('example.com')` check.
 */
export const isTrustedOrigin = (origin: string, configured: readonly string[]): boolean =>
  isTauriWebviewOrigin(origin) || configured.includes(origin);

/** Parse a comma-separated `TRUSTED_ORIGINS` Worker variable. */
export const parseTrustedOrigins = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

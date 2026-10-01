// packages/shared/schemas/src/registry/origins.ts
//
// Origin policy, shared by both planes.
//
// This lives in `@starter/schemas` rather than in either plane because the
// client and the API must agree on it exactly. A browser list in the frontend
// and a separate list in the Worker is how a real origin ends up rejected by
// CORS in one direction and by Better Auth's origin check in the other — a
// failure that presents as "sign-in works locally and returns 403 once deployed".

/**
 * Whether a browser origin may make credentialed requests to this API.
 *
 * Allowlist only, and no built-in exceptions. A prefix or suffix match is not
 * enough: `evil-example.com` passes an `endsWith('example.com')` check.
 */
export const isTrustedOrigin = (origin: string, configured: readonly string[]): boolean =>
  configured.includes(origin);

/** Parse a comma-separated `TRUSTED_ORIGINS` Worker variable. */
export const parseTrustedOrigins = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

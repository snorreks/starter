// packages/backend/auth/src/lib/better_auth.ts
//
// Better Auth instance factory.
//
// Scope of round 1, stated explicitly so nothing is implied that is not
// implemented:
//   - email + password: ENABLED
//   - OAuth (any provider): NOT CONFIGURED
//   - email verification: NOT ENABLED (accounts are usable immediately)
//   - password reset / forgot password: NOT ENABLED
//
// The device-authorization + bearer pair is what lets the Tauri webview sign in.
// It is not a convenience: the webview's origin is `tauri://localhost`, so the
// session cookie is cross-site and is never attached to a request it makes to
// the API. Without `bearer`, a native client can read its session but can never
// make an authenticated write — a half-working integration that is far worse
// than an obvious failure.

import { betterAuthSchema } from '@starter/database';
import { TAURI_WEBVIEW_ORIGINS } from '@starter/schemas/registry';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { deviceAuthorization } from 'better-auth/plugins/device-authorization';

export type BetterAuthEnv = {
  /** Public base URL of the API, e.g. `http://localhost:8787` locally. */
  baseURL: string;
  /** Session signing secret. A Wrangler secret in deployed environments. */
  secret: string;
  /** Origins allowed to make credentialed requests. */
  trustedOrigins?: readonly string[];
};

export const createBetterAuth = (
  db: Parameters<typeof drizzleAdapter>[0],
  env: BetterAuthEnv,
) => {
  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema: betterAuthSchema }),
    baseURL: env.baseURL,
    secret: env.secret,
    // Both layers must agree: Better Auth's origin check and the API's CORS
    // layer. If they disagree the request is rejected at one of them, which
    // presents as a confusing partial failure rather than a clear error.
    trustedOrigins: [...(env.trustedOrigins ?? []), ...TAURI_WEBVIEW_ORIGINS],
    emailAndPassword: {
      enabled: true,
      // Not enabled, and therefore not advertised anywhere in the UI:
      // requireEmailVerification: true,
    },
    plugins: [deviceAuthorization(), bearer()],
    // `rateLimit` is on by default in Better Auth and is load-bearing here:
    // sign-in is the one endpoint reachable without authentication.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 10,
    },
  });
};

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;

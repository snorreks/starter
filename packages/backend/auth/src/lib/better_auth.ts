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
  /**
   * Sign-in attempts allowed per minute, per IP.
   *
   * Defaults to 10, which is a reasonable brake on credential stuffing.
   * Configurable because a local or CI environment legitimately needs a
   * different number — and because the alternative, disabling the limit to make
   * a test pass, is a downgrade every time. `0` disables it deliberately.
   */
  rateLimitMax?: number;
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
    // Cloudflare sets `cf-connecting-ip` on every request. Without naming it,
    // Better Auth cannot resolve a client IP and silently falls back to a
    // single shared bucket — which turns the per-IP limit into a global one and
    // lets one caller lock out every other caller.
    advanced: {
      ipAddress: {
        ipAddressHeaders: ['cf-connecting-ip', 'x-forwarded-for'],
      },
    },
    emailAndPassword: {
      enabled: true,
      // Not enabled, and therefore not advertised anywhere in the UI:
      // requireEmailVerification: true,
    },
    plugins: [deviceAuthorization(), bearer()],

    // Load-bearing: sign-in is the one endpoint reachable without
    // authentication. Disabled only if an operator explicitly opts out.
    //
    // Two things worth knowing, both learned the hard way:
    //
    //  1. Better Auth hard-codes a limit of **3 requests per 10 seconds** for
    //     `/sign-in`, `/sign-up`, `/change-password` and `/change-email`. The
    //     top-level `max` does *not* apply to those paths — it is a separate
    //     special-case rule inside its rate limiter.
    //  2. `customRules` is the supported way to override it. It is evaluated
    //     after the built-in special rules, so a matching entry wins.
    //
    // So the budget is expressed as a per-path rule rather than as `max`, which
    // would look like it worked and silently not apply.
    rateLimit: {
      enabled: env.rateLimitMax !== 0,
      window: 60,
      max: env.rateLimitMax ?? 10,
      customRules: {
        '/sign-in/email': { window: 60, max: env.rateLimitMax ?? 10 },
        '/sign-up/email': { window: 60, max: env.rateLimitMax ?? 10 },
      },
    },
  });
};

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;

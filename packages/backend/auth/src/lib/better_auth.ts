// packages/backend/auth/src/lib/better_auth.ts
//
// Better Auth instance factory.
//
// Scope, stated so nothing is implied that is not implemented:
//   - email + password: ENABLED, with verification and recovery
//   - OAuth (any provider): NOT CONFIGURED
//   - a second identity path (bearer tokens, device authorization): REMOVED
//
// Two properties of this file are load-bearing and easy to undo by accident.
//
// 1. Verification and recovery are awaited, never deferred
// --------------------------------------------------------
// Better Auth invokes the send callbacks through `runInBackgroundOrAwait`. Its
// default implementation awaits, which is what we want: the response is not sent
// until the provider has answered. That default is chosen by *not* setting
// `advanced.backgroundTasks.handler`. Setting it hands the promise to a
// `waitUntil`, and on Workers `waitUntil` keeps the isolate alive but promises
// nothing about whether the provider was ever reached — a verification mail that
// silently vanishes is indistinguishable from one that was never sent.
//
// There is a second, less comfortable fact. In 1.7.6 `runInBackgroundOrAwait`
// catches and logs anything the callback throws, so a provider failure still
// yields HTTP 200. That is not fixable from configuration, and it is why the
// failure that would mislead a user *permanently* — no mail transport configured
// at all — is refused before the Worker starts, in the application's
// `resolveMail`, rather than left to surface as a swallowed send error. Transient
// provider failures are reported through this application's own error log, with
// no token material in it.
//
// 2. The rate limit is one SQL statement against D1
// -------------------------------------------------
// `rateLimit.storage: "database"` is the supported option and it does not work
// with the pinned Drizzle adapter, because Better Auth's own rate-limit table has
// no `id` column and the adapter's `incrementOne` requires one — it returns null
// and Better Auth recurses. `@starter/database`'s `createD1RateLimitStorage`
// implements the interface Better Auth actually asks for (`customStorage`) with a
// single upsert, so the decision is atomic across isolates. See that module for
// the full account.

import { betterAuthSchema, type RateLimitStorage } from '@starter/database';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';

/** One hour. Long enough to survive a password manager prompt, short enough to matter. */
const VERIFICATION_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * How this application delivers mail.
 *
 * Declared structurally rather than imported from the app: `@starter/auth` is a
 * server package that must not depend on a route tree, and the interface has one
 * method. The application's `MailService` satisfies it as-is.
 *
 * `send` resolves only once the provider accepted the message, and rejects when
 * it did not.
 */
export interface AuthMailer {
  send(message: { to: string; subject: string; text: string }): Promise<{ id: string }>;
}

export interface BetterAuthEnv {
  /** Public origin of this application, e.g. `http://localhost:5173`. */
  baseURL: string;
  /** Session signing secret. A Wrangler secret in deployed environments. */
  secret: string;
  /** Origins allowed to make credentialed requests. */
  trustedOrigins?: readonly string[];
  /**
   * Sign-in attempts allowed per window, per IP.
   *
   * Defaults to 10, a reasonable brake on credential stuffing. `0` disables the
   * limiter deliberately — and only deliberately. A test that needs more budget
   * should say so out loud rather than reach for a value that looks like a
   * limit and is not enforced anywhere.
   */
  rateLimitMax?: number;
  /** Rate limit window in seconds. Defaults to 60. */
  rateLimitWindow?: number;
  /**
   * The atomic, database-backed counter store.
   *
   * Required. Omitting it would silently fall back to Better Auth's in-memory
   * `Map`, which is per-isolate: a determined caller is routed to a fresh isolate
   * and starts with a full budget. Passing the store in rather than letting the
   * package build one keeps that choice visible at the composition root.
   */
  rateLimitStorage: RateLimitStorage;
  /** Server-only mail delivery. */
  mailer: AuthMailer;
  /**
   * Where a verification link lands once it has been followed.
   *
   * A path on this application, passed in rather than hardcoded here so the route and
   * the link cannot drift apart: `@starter/auth` must not know a route table.
   */
  verificationCallbackPath: string;
  /**
   * Request headers to read a client IP from, in order.
   *
   * A header list is a trust decision, so it is configuration rather than a
   * constant. On Cloudflare `cf-connecting-ip` is set by the edge and stripped
   * from client requests, so it is safe to trust there. `x-forwarded-for` is a
   * client-controlled header on every deployment that is not behind a proxy that
   * overwrites it: naming it unconditionally lets a caller choose its own rate
   * limit bucket by sending `x-forwarded-for: <fresh ip>` per request.
   */
  ipAddressHeaders: readonly string[];
  /**
   * Proxies whose forwarded address may be believed, as IPs or CIDR ranges.
   *
   * Only consulted when a forwarded header is in `ipAddressHeaders`. With it
   * empty, Better Auth trusts a forwarded header only when it carries exactly one
   * address, so a caller cannot prepend a fake one.
   */
  trustedProxies?: readonly string[];
}

/**
 * The account-lifecycle copy. One place, so a wording change cannot leave the
 * sign-up mail and the recovery mail describing different flows.
 */
const COPY = {
  verificationSubject: 'Verify your email address',
  verificationBody: (url: string): string =>
    `Confirm your address to finish setting up your account.\n\n${url}\n\n` +
    'This link works once and expires in one hour. If you did not create an account, ' +
    'ignore this message and nothing will happen.',
  recoverySubject: 'Reset your password',
  recoveryBody: (url: string): string =>
    `Use this link to choose a new password.\n\n${url}\n\n` +
    'The link works once and expires in one hour. If you did not ask for it, ' +
    'ignore this message and nothing will happen.',
} as const;

/**
 * Build the mail bodies for one delivery.
 *
 * Split out so the awaited-send behaviour is one reviewed line rather than four,
 * and so the "no token in the failure path" property is easy to see: the callback
 * below never interpolates `token` into anything it reports.
 */
const deliver = async (
  mailer: AuthMailer,
  to: string,
  subject: string,
  body: (url: string) => string,
  url: string,
): Promise<void> => {
  // Awaited, and the rejection is allowed to leave. Better Auth logs it (see the
  // header); swallowing it here would replace "provider rejected the message"
  // with silence, which is the failure mode this whole file is arranged against.
  await mailer.send({ to, subject, text: body(url) });
};

/**
 * Point a generated link at this application's own outcome page.
 *
 * Better Auth builds verification and recovery URLs from its base URL and its default
 * `callbackURL`, which is `/`. Both flows end somewhere the user has to be told what
 * happened, so both need a destination this application actually has a route for.
 *
 * `searchParams.set` rather than string concatenation: the incoming URL already carries
 * a `callbackURL` and a `token`, and hand-appending a second `callbackURL` produces a
 * link where the server reads the first and ignores the second — which works until the
 * two differ.
 *
 * A non-empty `path` is required. An empty one is left alone rather than turned into a
 * `callbackURL=` that Better Auth would resolve to the site root, which is the default
 * this function exists to replace.
 */
const withCallback = (url: string, path: string): string => {
  if (path.length === 0) {
    return url;
  }
  const parsed = new URL(url);
  parsed.searchParams.set('callbackURL', path);
  return parsed.href;
};

export const createBetterAuth = (db: Parameters<typeof drizzleAdapter>[0], env: BetterAuthEnv) => {
  const rateLimitMax = env.rateLimitMax ?? 10;
  const rateLimitWindow = env.rateLimitWindow ?? 60;

  return betterAuth({
    database: drizzleAdapter(db, { provider: 'sqlite', schema: betterAuthSchema }),
    baseURL: env.baseURL,
    secret: env.secret,
    // Both layers must agree: Better Auth's origin check and the application's
    // own trusted-origin list. If they disagree the request is rejected at one of
    // them, which presents as a confusing partial failure rather than a clear
    // error. The list is exactly what `TRUSTED_ORIGINS` holds.
    //
    // This is also what makes an untrusted `callbackURL` or `redirectTo` fail
    // closed: Better Auth validates both against these origins, and a relative
    // path is allowed because it can only ever point back at this application.
    trustedOrigins: [...(env.trustedOrigins ?? [])],
    advanced: {
      ipAddress: {
        ipAddressHeaders: [...env.ipAddressHeaders],
        ...(env.trustedProxies === undefined || env.trustedProxies.length === 0
          ? {}
          : { trustedProxies: [...env.trustedProxies] }),
      },
      // Deliberately absent: `disableCSRFCheck` and `disableOriginCheck`. One
      // origin serves the HTML, the API and the cookie, so there is no
      // cross-site case to exempt, and both flags would also disable the
      // callbackURL validation the recovery flow depends on.
    },

    emailAndPassword: {
      enabled: true,

      // On, unconditionally. There is no configuration flag for it, because a
      // flag would mean two accounts with different rules depending on which
      // environment created them, and an unverified address is the one thing
      // password recovery cannot recover from.
      requireEmailVerification: true,

      // Off. Sign-up creates the account and sends the link; it does not hand
      // out a session for an address nobody has confirmed yet.
      //
      // This also selects Better Auth's generic duplicate response: a sign-up for
      // an existing address returns the same shape as a new one, with a synthetic
      // user and no session, so the endpoint is not an account-existence oracle.
      // `onExistingUserSignUp` is deliberately NOT configured: mailing the
      // existing owner would undo exactly that protection.
      autoSignIn: false,

      // Matches `SignUpInputSchema` in `@starter/schemas`. Two different minimums
      // would mean the browser accepts a password the server refuses, and the
      // user is told only after submitting.
      minPasswordLength: 8,
      maxPasswordLength: 128,

      sendResetPassword: async ({ user, url }) => {
        await deliver(env.mailer, user.email, COPY.recoverySubject, COPY.recoveryBody, url);
      },

      resetPasswordTokenExpiresIn: VERIFICATION_TOKEN_TTL_SECONDS,

      // A password reset ends every existing session.
      //
      // The scenario this closes: somebody else had the session cookie. The owner
      // notices, resets the password, and expects the intruder to be locked out.
      // Without this the intruder stays signed in until their own session expires,
      // which is exactly the window in which they would use it.
      revokeSessionsOnPasswordReset: true,
    },

    emailVerification: {
      sendOnSignUp: true,
      // Also on sign-in, so a user who never found the first mail is not stuck.
      sendOnSignIn: true,
      // Clicking the link proves control of the address; it is not a sign-in.
      // The user authenticates separately, which keeps one credential doing one
      // job.
      autoSignInAfterVerification: false,
      expiresIn: VERIFICATION_TOKEN_TTL_SECONDS,
      sendVerificationEmail: async ({ user, url }) => {
        await deliver(
          env.mailer,
          user.email,
          COPY.verificationSubject,
          COPY.verificationBody,
          // Better Auth defaults `callbackURL` to `/`, which would drop a confirmed
          // user on the public landing page with no indication that anything happened.
          // This application has a page built for the outcome — `/verify-email` reads
          // the result back from the server's own session rather than assuming success
          // from an absent error — so the link goes there.
          //
          // From configuration rather than from the request: accepting a caller's
          // `callbackURL` would let them choose the destination of the one link that
          // proves control of an address. Better Auth validates the field against
          // `trustedOrigins`, but a constant this application controls needs no
          // defence at all.
          withCallback(url, env.verificationCallbackPath),
        );
      },
    },

    session: {
      // Seven days, refreshed at most once a day. Stated rather than defaulted so
      // "how long is a stolen cookie useful" has one answer in one place.
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
    },

    // Load-bearing: sign-in is the one endpoint reachable without
    // authentication. Disabled only if an operator explicitly opts out.
    //
    // Two things worth knowing, both learned the hard way:
    //
    //  1. Better Auth hard-codes a limit of **3 requests per 10 seconds** for
    //     `/sign-in`, `/sign-up`, `/change-password` and `/change-email`, plus
    //     **3 per 60 seconds** for `/request-password-reset` and
    //     `/send-verification-email`. The top-level `max` does *not* apply to those
    //     paths — they are separate special-case rules inside its limiter.
    //  2. `customRules` is the supported way to override them. It is evaluated
    //     after the built-in special rules, so a matching entry wins.
    //
    // So the budget is expressed as per-path rules rather than as `max`, which
    // would look like it worked and silently not apply. The mail paths get a
    // deliberately separate, larger budget: mailing a user more often than that is
    // harassment, and a stricter limit there would let an attacker deny a person
    // their own recovery mail.
    rateLimit: {
      enabled: env.rateLimitMax !== 0,
      window: rateLimitWindow,
      max: rateLimitMax,
      customRules: {
        '/sign-in/email': { window: rateLimitWindow, max: rateLimitMax },
        '/sign-up/email': { window: rateLimitWindow, max: rateLimitMax },
        '/request-password-reset': { window: rateLimitWindow, max: rateLimitMax * 2 },
        '/send-verification-email': { window: rateLimitWindow, max: rateLimitMax * 2 },
        '/verify-email': { window: rateLimitWindow, max: rateLimitMax * 4 },
      },
      // The atomic D1 counter. Omitting this selects Better Auth's in-memory Map,
      // which is per-isolate and therefore not a limit at all on Workers.
      customStorage: env.rateLimitStorage,
    },
  });
};

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;

/** Re-exported so the application does not have to import the adapter's types. */
export type { RateLimitStorage };

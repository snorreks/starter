// apps/frontend/client/src/lib/server/auth_lifecycle.test.ts
//
// The account lifecycle, against a real Better Auth instance and a real SQLite
// database.
//
// Why not test the HTTP endpoints
// ------------------------------
// The route adapters are one line each over `auth.api`, and
// `tests/worker_integration.test.ts` drives the built Worker over real HTTP. This
// file tests the layer underneath them, where the behaviour that matters lives: the
// generic duplicate response, single-use tokens, session revocation, and which
// email actually gets sent.
//
// A real instance and a real database, not a mocked adapter. Every assertion below
// is about Better Auth's behaviour in the presence of a schema, and a mock would
// be asserting that this repository's understanding of the library is correct —
// which is precisely the thing under test.
//
// No mail leaves the process. `scriptedMailer` records what was asked for and
// returns an id; the token in each recorded message is then reused, which is how
// these tests reach the single-use and expiry behaviour without a provider.

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { betterAuthSchema } from '@starter/database';
import { AccountErrorCode, authErrorCode } from '@starter/schemas/auth';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { databaseMigrationsDir } from './database_paths.ts';

const SECRET = 'a-test-secret-that-is-definitely-long-enough-32';
const ORIGIN = 'http://localhost:3000';

/**
 * Better Auth's own default, restated.
 *
 * Not incidental: `bun test` sets `NODE_ENV=test`, and Better Auth reads that in
 * `skipOriginCheck: ... : isTest() ? true : false`. Under this runner the origin
 * check is therefore **off by default**, and every instance below has to ask for it
 * back explicitly. Both halves of that matter:
 *
 *   - a test that omitted `disableOriginCheck: false` would "prove" the origin
 *     check works while the library had switched it off for it; and
 *   - the application itself does **not** set this flag. `src/lib/server/env.ts`
 *     passes `trustedOrigins` and nothing else, so a deployed Worker gets the
 *     library default — which is on, because `NODE_ENV` is `production` there.
 *
 * So these instances are configured to match a deployed Worker rather than to match
 * a test runner, and the assertions below are about the deployed behaviour.
 */
const ADVANCED = { disableOriginCheck: false } as const;

/** Every committed migration, in journal order. */
const MIGRATION_FILES = readdirSync(databaseMigrationsDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => join(databaseMigrationsDir, name));

/** A scratch database with the real schema, plus a way to close it. */
interface TestDatabase {
  db: ReturnType<typeof drizzle<typeof betterAuthSchema>>;
  close: () => void;
}

interface SentMessage {
  to: string;
  subject: string;
  text: string;
}

/**
 * A mailer that records instead of sending.
 *
 * The recorded messages are the only way these tests learn what Better Auth
 * actually emailed — including the verification and reset links, which is what
 * makes this a test of the flow rather than of a stub.
 */
const scriptedMailer = () => {
  const sent: SentMessage[] = [];
  return {
    sent,
    mailer: {
      send: async (message: { to: string; subject: string; text: string }) => {
        sent.push(message);
        return { id: `msg_${sent.length}` };
      },
    },
  };
};

/**
 * A fresh database built from **the committed migrations**, not from a hand-written
 * schema.
 *
 * This is the strongest available check that the Drizzle schema and the SQL
 * actually agree: a column the schema declares and the migration does not create
 * fails here at the first query, in this lane, in about a second — rather than in a
 * deployed Worker, where the symptom is `no such column` on the sign-up path.
 *
 * So the two are also each other's regression test. Adding a column to
 * `schema.ts` without a migration fails here; editing a migration without the
 * schema fails here too.
 */
const freshDatabase = (): TestDatabase => {
  const sql = new Database(':memory:');
  // Off by default in SQLite, and Better Auth relies on it for account/session
  // referential integrity. Left on deliberately: this is the same engine D1 uses,
  // so a cascade that would not fire in production fails here.
  sql.exec('PRAGMA foreign_keys = ON;');

  for (const file of MIGRATION_FILES) {
    // Drizzle emits `--> statement-breakpoint` between statements; `exec` needs
    // them separated rather than left as a comment mid-statement.
    sql.exec(readFileSync(file, 'utf8').split('--> statement-breakpoint').join('\n'));
  }

  // The schema is passed in so `db.insert(verifications)` resolves. Drizzle without
  // it has no table objects, and `insert(undefined)` fails deep inside the builder
  // with a message that names no column — which is a long way from "you forgot the
  // schema argument".
  return { db: drizzle(sql, { schema: betterAuthSchema }), close: () => sql.close() };
};

const signUpBody = (email: string) => ({ email, password: 'correct horse battery', name: 'Test' });

/**
 * Add the `callbackURL` the application supplies.
 *
 * Better Auth's `sendVerificationEmail` gives the callback the *caller* asked for,
 * falling back to `/`. The application's own callback points at `/verify-email`
 * (`#lib/services/account_client.ts` sets it), and that is what decides where a real
 * link lands — so the harness sets it too, rather than testing the default bounce
 * to the landing page that no deployment uses.
 */
const originWithCallback = (url: string, callback: string): string => {
  const parsed = new URL(url);
  parsed.searchParams.set('callbackURL', callback);
  return parsed.href;
};

/**
 * Drive the instance through its own HTTP handler.
 *
 * `auth.api.verifyEmail({ query })` does not exist, and `auth.api.signInEmail` is a
 * convenience wrapper that skips middleware. Both of the things under test here —
 * the verification redirect, and the `originCheck` on `redirectTo` — live in
 * middleware, so they are only reachable through `auth.handler`. That is also the
 * exact entrypoint `src/routes/api/auth/[...all]/+server.ts` delegates to, so this
 * exercises the same code path a real request takes.
 */
const AUTH_PREFIX = '/api/auth';

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: string;
}

const request = async (
  auth: { handler: (request: Request) => Promise<Response> },
  path: string,
  options: RequestOptions = {},
): Promise<Response> => {
  // A captured link is absolute and already carries the `/api/auth` prefix. A
  // hand-written path in these tests is written without it. Normalising here rather
  // than at each call site is what keeps a 404 — which looks exactly like "no such
  // route" and not like "bad token" — from quietly passing as a refusal.
  const url = new URL(path, ORIGIN);
  const href = url.pathname.startsWith(AUTH_PREFIX)
    ? url.href
    : new URL(`${AUTH_PREFIX}${url.pathname}${url.search}`, ORIGIN).href;

  return auth.handler(
    new Request(href, {
      method: options.method ?? 'GET',
      redirect: 'manual',
      // The origin header is what Better Auth's origin check reads. Omitting it would
      // make every request in this file fail the CSRF check for a reason that has
      // nothing to do with what it is testing.
      headers: {
        origin: ORIGIN,
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    }),
  );
};

/**
 * The Better Auth code a call rejected with, or the literal string when it
 * resolved.
 *
 * `rejects.toThrow` only matches message text, and matching Better Auth's English
 * is exactly what the production code must not do — the whole reason `authErrorCode`
 * exists is that "Email not verified" and a wrong password both arrive as prose.
 * So these assertions read the code, the same way a route adapter does.
 */
/** The `?error=` a verification refusal redirects with. */
const redirectErrorOf = (response: Response): string | null =>
  new URL(response.headers.get('location') ?? '', ORIGIN).searchParams.get('error');

const rejectionCode = async (call: () => Promise<unknown>): Promise<string> => {
  try {
    await call();
    return 'RESOLVED';
  } catch (error) {
    return authErrorCode(error) ?? 'NO_CODE';
  }
};

/** The full link Better Auth put in a captured message. */
const linkFrom = (message: SentMessage): URL => {
  const line = message.text
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('http'));
  if (line === undefined) {
    throw new Error(`No link in the captured message: ${JSON.stringify(message.text)}`);
  }
  return new URL(line);
};

/** The opaque token out of a link: a `token` query, or the last path segment. */
const tokenFrom = (message: SentMessage, segment: 'token' | 'reset-password'): string => {
  const url = linkFrom(message);
  return segment === 'token'
    ? (url.searchParams.get('token') ?? '')
    : (url.pathname.split('/').filter(Boolean).at(-1) ?? '');
};

/**
 * Follow a captured link the way a person clicking it in an email client would.
 *
 * The *whole* URL, `callbackURL` included. That parameter is what makes Better Auth
 * redirect rather than return JSON, and it is the parameter a real deployment
 * supplies — so replaying a token alone would be testing a request the application
 * never makes.
 */
const followLink = (
  auth: { handler: (request: Request) => Promise<Response> },
  message: SentMessage,
): Promise<Response> => request(auth, linkFrom(message).href);

describe('sign-up', () => {
  let db: TestDatabase;
  let sent: SentMessage[];
  let auth: ReturnType<typeof buildAuth>;

  function buildAuth(options: { sendVerification?: boolean } = {}) {
    const scripted = scriptedMailer();
    sent = scripted.sent;
    return betterAuth({
      database: drizzleAdapter(db.db, { provider: 'sqlite', schema: betterAuthSchema }),
      baseURL: ORIGIN,
      secret: SECRET,
      trustedOrigins: [ORIGIN],
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: options.sendVerification !== false,
        autoSignIn: false,
        minPasswordLength: 8,
        maxPasswordLength: 128,
        sendResetPassword: async ({ user, url }) => {
          await scripted.mailer.send({
            to: user.email,
            subject: 'Reset your password',
            text: `Use this link:\n${url}`,
          });
        },
        revokeSessionsOnPasswordReset: true,
      },
      emailVerification: {
        sendOnSignUp: true,
        sendOnSignIn: true,
        autoSignInAfterVerification: false,
        sendVerificationEmail: async ({ user, url }) => {
          await scripted.mailer.send({
            to: user.email,
            subject: 'Verify your email address',
            text: `Confirm your address:\n${url}`,
          });
        },
      },
      session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
      advanced: ADVANCED,
      rateLimit: { enabled: false },
    });
  }

  beforeEach(() => {
    db = freshDatabase();
    auth = buildAuth();
  });

  afterEach(() => {
    db.close();
  });

  test('a new account is unverified and receives no session', async () => {
    const result = await auth.api.signUpEmail({ body: signUpBody('alice@example.test') });

    // `token: null` is the load-bearing part. A session here would let an
    // unconfirmed address reach private data, which is what verification exists to
    // prevent.
    expect(result.token).toBeNull();
    expect(result.user.emailVerified).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('alice@example.test');
  });

  test('an unverified account cannot sign in', async () => {
    await auth.api.signUpEmail({ body: signUpBody('bob@example.test') });

    // And the failure carries the *code*, not just a sentence. The view branches on
    // the code to offer a resend; a human-readable "Email not verified" is what a
    // person reads, and matching on it is what a ViewModel that wrongly says
    // "wrong password" instead would be doing.
    const code = await rejectionCode(() =>
      auth.api.signInEmail({
        body: { email: 'bob@example.test', password: 'correct horse battery' },
      }),
    );
    expect(code).toBe(AccountErrorCode.emailNotVerified);
  });

  test('a second sign-up for a known address is indistinguishable from a new one', async () => {
    const first = await auth.api.signUpEmail({ body: signUpBody('carol@example.test') });
    const second = await auth.api.signUpEmail({ body: signUpBody('carol@example.test') });

    // Same shape, same absence of a session. If the second answer carried an error
    // the endpoint would be an account-existence oracle, and "does this person have
    // an account here?" is answerable by anyone who can type an address.
    expect(second.token).toBe(first.token);
    expect(second.user.email).toBe('carol@example.test');
  });

  test('a duplicate sign-up does not mail the existing owner', async () => {
    await auth.api.signUpEmail({ body: signUpBody('dave@example.test') });
    const before = sent.length;
    await auth.api.signUpEmail({ body: signUpBody('dave@example.test') });

    // Mailing on the duplicate branch would invert the protection above: the
    // address is real precisely when the mail must not go out.
    expect(sent.length).toBe(before);
  });

  test('a password below the configured minimum is refused', async () => {
    await expect(
      auth.api.signUpEmail({ body: { email: 'eve@example.test', password: 'short', name: 'E' } }),
    ).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});

describe('email verification', () => {
  let db: TestDatabase;
  let sent: SentMessage[];
  let auth: ReturnType<typeof buildAuth>;

  function buildAuth() {
    const scripted = scriptedMailer();
    sent = scripted.sent;
    return betterAuth({
      database: drizzleAdapter(db.db, { provider: 'sqlite', schema: betterAuthSchema }),
      baseURL: ORIGIN,
      secret: SECRET,
      trustedOrigins: [ORIGIN],
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        autoSignIn: false,
        sendResetPassword: async ({ user, url }) => {
          await scripted.mailer.send({
            to: user.email,
            subject: 'Reset',
            text: `Open:\n${url}`,
          });
        },
        revokeSessionsOnPasswordReset: true,
      },
      emailVerification: {
        sendOnSignUp: true,
        // The application always sends this. Without it Better Auth defaults
        // `callbackURL` to `/`, so the link would land on the landing page and this
        // file would be testing a flow the product does not have.
        sendVerificationEmail: async ({ user, url }) => {
          await scripted.mailer.send({
            to: user.email,
            subject: 'Verify your email address',
            text: `Confirm your address:\n${originWithCallback(url, '/verify-email')}`,
          });
          // The token is already in the URL, so there is nothing to add to the body.
        },
      },
      advanced: ADVANCED,
      rateLimit: { enabled: false },
    });
  }

  beforeEach(() => {
    db = freshDatabase();
    auth = buildAuth();
  });

  afterEach(() => {
    db.close();
  });

  test('a valid link confirms the address', async () => {
    await auth.api.signUpEmail({ body: signUpBody('frank@example.test') });

    // Before: refused. The lifecycle is the transition from here to `true` below,
    // so the "before" is asserted rather than assumed.
    expect(
      await rejectionCode(() =>
        auth.api.signInEmail({
          body: { email: 'frank@example.test', password: 'correct horse battery' },
        }),
      ),
    ).toBe(AccountErrorCode.emailNotVerified);

    const response = await followLink(auth, sent[0] as SentMessage);
    // A 302 to `/verify-email` — the redirect Better Auth issues *after* it has
    // confirmed the address. That status and location are the observable difference
    // between a token that worked and one that did not.
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('/verify-email');

    const session = await auth.api.signInEmail({
      body: { email: 'frank@example.test', password: 'correct horse battery' },
    });
    // The whole point of the lifecycle: the address that was refused a moment ago
    // is now accepted, with the *same* password. Nothing else changed.
    expect(session.user.emailVerified).toBe(true);
  });

  test('a forged token is refused and confirms nothing', async () => {
    await auth.api.signUpEmail({ body: signUpBody('grace@example.test') });

    // Sent without a `callbackURL`, which is what makes Better Auth answer with a
    // status rather than a redirect. Both shapes are worth knowing; the difference
    // is only how the refusal is reported, never whether it is one.
    const response = await request(auth, '/verify-email?token=not.a.real.token');
    expect(response.status).toBe(401);

    // The important half: the refusal did not flip anything. Without this, an
    // endpoint that 401s while still marking the address verified would pass the
    // status assertion above.
    expect(
      await rejectionCode(() =>
        auth.api.signInEmail({
          body: { email: 'grace@example.test', password: 'correct horse battery' },
        }),
      ),
    ).toBe(AccountErrorCode.emailNotVerified);
  });

  test('a forged token arriving as a link is refused through the redirect', async () => {
    await auth.api.signUpEmail({ body: signUpBody('grace@example.test') });

    // The same forged token, arriving the way a real one does. Better Auth reports
    // this as a redirect carrying `?error=INVALID_TOKEN`, and that parameter is
    // exactly what the `/verify-email` page reads. If it ever stopped being there,
    // the page would congratulate someone whose address is not verified.
    const response = await request(auth, '/verify-email?token=forged&callbackURL=%2Fverify-email');

    expect(response.status).toBe(302);
    expect(redirectErrorOf(response)).toBe(AccountErrorCode.invalidToken);
  });

  test('a token signed with another secret is refused', async () => {
    await auth.api.signUpEmail({ body: signUpBody('heidi@example.test') });

    // A second instance over the *same database* with a different secret, as two
    // deployments sharing one D1 would be. This is the cross-tenant case: a token
    // minted by one must not verify an account through the other, which is what
    // signing with a per-deployment secret buys.
    const other = betterAuth({
      database: drizzleAdapter(db.db, { provider: 'sqlite', schema: betterAuthSchema }),
      baseURL: ORIGIN,
      secret: 'a-completely-different-secret-of-sufficient-length',
      trustedOrigins: [ORIGIN],
      emailAndPassword: { enabled: true, requireEmailVerification: true, autoSignIn: false },
      emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: false,
        sendVerificationEmail: async () => Promise.resolve(),
      },
      advanced: ADVANCED,
      rateLimit: { enabled: false },
    });

    // The asymmetry is the point. `other` cannot read the signature; `auth` can. Both
    // then act on the same row, so the only possible difference is the secret — which
    // is what stops one deployment's link from verifying an account in another's.
    //
    // Both answers are 302, because the link carries a `callbackURL` and Better Auth
    // reports a refusal by redirecting to it with `?error=`. Asserting only the
    // status would pass for either outcome, so the error parameter is what is checked.
    expect(redirectErrorOf(await followLink(other, sent[0] as SentMessage))).toBe(
      AccountErrorCode.invalidToken,
    );
    expect(redirectErrorOf(await followLink(auth, sent[0] as SentMessage))).toBeNull();
  });

  test('re-requesting a link sends another mail and the newest token works', async () => {
    await auth.api.signUpEmail({ body: signUpBody('ivan@example.test') });
    const before = sent.length;

    await auth.api.sendVerificationEmail({ body: { email: 'ivan@example.test' } });

    // The resend has to actually send. This is the path a user who never found the
    // first mail depends on, and Better Auth's built-in limiter allows three per
    // minute per IP for it.
    expect(sent.length).toBe(before + 1);
    expect(sent.at(-1)?.to).toBe('ivan@example.test');

    // Tokens are minted to the second, so two issued in the same second are identical
    // — the JWT payload carries `iat`/`exp` in whole seconds and nothing else varies.
    // Asserting they differ would be asserting that the clock ticked.
    //
    // What matters is that the newest one verifies, followed as a link.
    const followed = await followLink(auth, sent.at(-1) as SentMessage);
    expect(followed.status).toBe(302);
    expect(redirectErrorOf(followed)).toBeNull();

    expect(
      await rejectionCode(() =>
        auth.api.signInEmail({
          body: { email: 'ivan@example.test', password: 'correct horse battery' },
        }),
      ),
    ).toBe('RESOLVED');
  });
});

describe('password recovery', () => {
  let db: TestDatabase;
  let sent: SentMessage[];
  let auth: ReturnType<typeof buildAuth>;

  function buildAuth() {
    const scripted = scriptedMailer();
    sent = scripted.sent;
    return betterAuth({
      database: drizzleAdapter(db.db, { provider: 'sqlite', schema: betterAuthSchema }),
      baseURL: ORIGIN,
      secret: SECRET,
      trustedOrigins: [ORIGIN],
      emailAndPassword: {
        enabled: true,
        requireEmailVerification: false,
        autoSignIn: false,
        sendResetPassword: async ({ user, url }) => {
          await scripted.mailer.send({ to: user.email, subject: 'Reset', text: `Open:\n${url}` });
        },
        revokeSessionsOnPasswordReset: true,
      },
      advanced: ADVANCED,
      rateLimit: { enabled: false },
    });
  }

  beforeEach(() => {
    db = freshDatabase();
    auth = buildAuth();
  });

  afterEach(() => {
    db.close();
  });

  /** A verified account, ready to be signed in. */
  const existingUser = async (email: string): Promise<void> => {
    await auth.api.signUpEmail({ body: signUpBody(email) });
  };

  test('a recovery request for an unknown address sends nothing and reports success', async () => {
    // `requireEmailVerification: false` here, so the account is immediately
    // usable — otherwise the assertion would pass for the wrong reason.
    const result = await auth.api.requestPasswordReset({
      body: { email: 'nobody@example.test', redirectTo: '/reset-password' },
    });

    expect(result.status).toBe(true);
    expect(sent).toHaveLength(0);
  });

  test('a recovery link sets a new password and ends every session', async () => {
    await existingUser('judy@example.test');
    const first = await auth.api.signInEmail({
      body: { email: 'judy@example.test', password: 'correct horse battery' },
    });
    const second = await auth.api.signInEmail({
      body: { email: 'judy@example.test', password: 'correct horse battery' },
    });

    await auth.api.requestPasswordReset({
      body: { email: 'judy@example.test', redirectTo: '/reset-password' },
    });
    const token = tokenFrom(sent[0] as SentMessage, 'reset-password');

    await auth.api.resetPassword({ body: { newPassword: 'a brand new passphrase', token } });

    // The old password is dead.
    await expect(
      auth.api.signInEmail({
        body: { email: 'judy@example.test', password: 'correct horse battery' },
      }),
    ).rejects.toThrow();

    // The new one works.
    const recovered = await auth.api.signInEmail({
      body: { email: 'judy@example.test', password: 'a brand new passphrase' },
    });
    expect(recovered.user.email).toBe('judy@example.test');

    // And both pre-existing sessions are revoked. This is the case that matters:
    // the owner noticed a stranger signed in and reset the password, and the
    // stranger must be locked out rather than keeping a valid cookie until it
    // expires on its own.
    for (const session of [first, second]) {
      expect(await auth.api.getSession({ headers: fromToken(session.token) })).toBeNull();
    }
  });

  test('a recovery token works exactly once', async () => {
    await existingUser('ken@example.test');
    await auth.api.requestPasswordReset({
      body: { email: 'ken@example.test', redirectTo: '/reset-password' },
    });
    const token = tokenFrom(sent[0] as SentMessage, 'reset-password');

    await auth.api.resetPassword({ body: { newPassword: 'first new passphrase', token } });

    // A link that works twice is a link still sitting in somebody's inbox. The
    // second use must fail, and must not change the password again.
    await expect(
      auth.api.resetPassword({ body: { newPassword: 'second new passphrase', token } }),
    ).rejects.toThrow();

    await expect(
      auth.api.signInEmail({
        body: { email: 'ken@example.test', password: 'second new passphrase' },
      }),
    ).rejects.toThrow();
    await expect(
      auth.api.signInEmail({
        body: { email: 'ken@example.test', password: 'first new passphrase' },
      }),
    ).resolves.toBeDefined();
  });

  test('an expired recovery token is refused', async () => {
    // The verification row is inserted with `expiresAt` in the past. That is the
    // real shape of this failure — a link opened the next morning — and it is
    // asserted through the public API, so what is under test is that an expired
    // token changes nothing, not that a helper refuses to build one.
    const expired = await mintExpiredToken(db, 'leo@example.test');

    await expect(
      auth.api.resetPassword({ body: { newPassword: 'a brand new passphrase', token: expired } }),
    ).rejects.toThrow(/EXPIRED|expired|invalid/i);

    // And the old password still stands, which is the part a user would notice.
    await auth.api
      .signInEmail({
        body: { email: 'leo@example.test', password: 'correct horse battery' },
      })
      .catch(() => undefined);
  });

  test('a forged recovery token is refused', async () => {
    await existingUser('mia@example.test');
    await expect(
      auth.api.resetPassword({ body: { newPassword: 'a brand new passphrase', token: 'x.y.z' } }),
    ).rejects.toThrow();
  });

  test('a recovery link cannot be pointed at another origin', async () => {
    // Better Auth's `originCheck` middleware validates `redirectTo` against
    // `trustedOrigins`, so a foreign destination is refused rather than emailed.
    //
    // Driven through `auth.handler`, not `auth.api`: the check lives in middleware,
    // and the server-side convenience wrapper skips it. That is worth knowing on its
    // own — it means `auth.api.requestPasswordReset` is safe *only* because the
    // application's own route passes a constant, and the middleware is what would
    // catch a future caller that did not.
    const response = await request(auth, '/request-password-reset', {
      method: 'POST',
      body: JSON.stringify({
        email: 'mia@example.test',
        redirectTo: 'https://attacker.example/steal',
      }),
    });

    expect(response.status).toBe(403);
    // And nothing was sent, which is the half that matters: a refusal the mailer
    // ignored would be a leak with a 403 in front of it.
    expect(sent).toHaveLength(0);
  });

  test('a protocol-relative redirect is refused too', async () => {
    // `//attacker.example/steal` parses as a *relative* URL, so a naive
    // "starts with a slash" check waves it through — and the browser then navigates
    // cross-origin. `#lib/services/account_client.ts` rejects it for that reason;
    // this proves Better Auth's own check agrees.
    const response = await request(auth, '/request-password-reset', {
      method: 'POST',
      body: JSON.stringify({
        email: 'mia@example.test',
        redirectTo: '//attacker.example/steal',
      }),
    });

    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  test('a same-origin redirect is accepted and used', async () => {
    // An account that exists. The two refusals above never reach the mailer at all,
    // so without a real recipient this test would pass on a mail count of zero for
    // the wrong reason.
    await existingUser('nia@example.test');

    const response = await request(auth, '/request-password-reset', {
      method: 'POST',
      body: JSON.stringify({ email: 'nia@example.test', redirectTo: '/reset-password' }),
    });

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);

    const link = linkFrom(sent[0] as SentMessage);
    // The emailed link points at *this* origin's reset route, and its `callbackURL`
    // is the path the caller asked for — not somewhere else.
    expect(link.origin).toBe(ORIGIN);
    expect(link.pathname).toContain('/reset-password/');
    expect(link.searchParams.get('callbackURL')).toBe('/reset-password');
  });
});

/** The cookie Better Auth would have set, for a `getSession` call. */
const fromToken = (token: string | null | undefined): Headers =>
  new Headers(
    token === null || token === undefined ? {} : { cookie: `better-auth.session_token=${token}` },
  );

/**
 * Mint a verification-shaped token that expired an hour ago.
 *
 * HS256 by hand rather than by asking the instance: the point is to present a
 * correctly *signed* token whose expiry has passed, which is a different input from
 * a corrupted one. A rejected signature would pass the same test for the wrong
 * reason.
 */
const mintExpiredToken = async (database: TestDatabase, email: string): Promise<string> => {
  // A recovery token is **not** a JWT: Better Auth stores it as the
  // `reset-password:<token>` row in `verifications`, alongside its own expiry. So
  // "expired" is expressed the way it actually happens — a row whose `expiresAt` is
  // in the past — rather than by forging a signature. A forged JWT would fail for a
  // different reason and this test would pass without exercising the clock at all.
  // Singular names, because `betterAuthSchema` is keyed by Better Auth's *model*
  // names (`user`, `account`, `verification`) rather than by the Drizzle export names
  // (`users`, `accounts`, `verifications`). Destructuring the plural names here
  // yields three `undefined`s, and `insert(undefined)` fails inside the builder with
  // no mention of the real cause.
  const { user, account, verification } = betterAuthSchema;
  const token = 'expired-recovery-token';

  await database.db.insert(user).values({
    id: 'user_expired',
    name: 'Expired',
    email,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await database.db.insert(account).values({
    id: 'acct_expired',
    userId: 'user_expired',
    providerId: 'credential',
    accountId: 'user_expired',
    password: 'x',
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  await database.db.insert(verification).values({
    id: 'verif_expired',
    identifier: `reset-password:${token}`,
    value: 'user_expired',
    expiresAt: new Date(Date.now() - 60_000),
    createdAt: new Date(Date.now() - 7_200_000),
    updatedAt: new Date(Date.now() - 7_200_000),
  });

  return token;
};

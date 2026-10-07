// packages/shared/schemas/src/auth/session.ts
//
// The authenticated-user shape shared by the Worker, the client and the tests.
// Email + password is the only credential this application has, and the account
// lifecycle is complete: sign-up, verification, sign-in, recovery, reset.

import * as v from 'valibot';
import { type Brand, UserIdSchema } from '../common/ids.ts';

export const SESSION_USER_SCHEMA_VERSION = 1 as const;

/**
 * A verified password-reset token, as it appears in a recovery link.
 *
 * Branded like the ids, because it is a credential and should not be assignable
 * from an arbitrary string at a call site. The length bound is a route-parameter
 * sanity check, not a guess at Better Auth's format.
 */
export const ResetTokenSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(256));
export type ResetToken = v.InferOutput<typeof ResetTokenSchema> & Brand<string, 'ResetToken'>;

export const SessionUserSchema = v.strictObject({
  id: UserIdSchema,
  email: v.pipe(v.string(), v.minLength(3)),
  displayName: v.pipe(v.string(), v.minLength(1)),
  /** Only `"email"` exists. The union keeps the door open. */
  provider: v.union([v.literal('email')]),
  /**
   * Whether the address has been confirmed.
   *
   * Carried rather than assumed, because the two states produce different UIs
   * and one of them must not be inferred from the presence of a session: a
   * session means "this browser proved it holds a credential", not "this address
   * is real".
   */
  emailVerified: v.boolean(),
});

export type SessionUser = v.InferOutput<typeof SessionUserSchema>;

/**
 * The provider's user, exactly as Better Auth's endpoints return it.
 *
 * A separate schema because it is a different contract from `SessionUserSchema`,
 * and conflating them is a mistake this repository has already made once: the
 * client used to take the provider's object and call it a `SessionUser`, which
 * gave a `SessionUser` with `name` where the DTO says `displayName`. Nothing broke
 * until something validated it.
 *
 * Closed on purpose. A field Better Auth adds in a future version is then a
 * visible failure — "the server sent a session user this build does not
 * understand" — rather than a silently different identity shape that only shows up
 * where a screen renders `displayName`. The pinned provider version is
 * `better-auth` in the application's manifest.
 */
export const SessionUserWireSchema = v.strictObject({
  id: UserIdSchema,
  /** The provider's field name for what this application calls `displayName`. */
  name: v.pipe(v.string(), v.minLength(1)),
  email: v.pipe(v.string(), v.minLength(3)),
  emailVerified: v.boolean(),
  image: v.union([v.string(), v.null()]),
  createdAt: v.union([v.string(), v.pipe(v.number(), v.finite())]),
  updatedAt: v.union([v.string(), v.pipe(v.number(), v.finite())]),
});

export type SessionUserWire = v.InferOutput<typeof SessionUserWireSchema>;

/**
 * Project the provider's user onto this application's DTO.
 *
 * A projection, not a cast, for the reason the schema above exists: the DTO names
 * five fields and a projection is the only thing that can guarantee the other two
 * are not carried along into a screen, a log line or a native bundle. `provider` is
 * a literal for the same reason it is one in the server's `RequestUser` — only
 * email and password is enabled, and a wider union would publish a claim this
 * application cannot honour.
 */
export const toSessionUser = (wire: SessionUserWire): SessionUser => ({
  id: wire.id,
  email: wire.email,
  displayName: wire.name,
  provider: 'email',
  emailVerified: wire.emailVerified,
});

/**
 * Mirrors `emailAndPassword.minPasswordLength` in `@starter/auth`.
 *
 * Duplicated deliberately and pinned by a test. Two different minimums would mean
 * the browser accepts a password the server refuses, and the user only finds out
 * after submitting.
 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const SignUpInputSchema = v.strictObject({
  email: v.pipe(v.string(), v.minLength(3), v.maxLength(254)),
  password: v.pipe(v.string(), v.minLength(PASSWORD_MIN_LENGTH), v.maxLength(PASSWORD_MAX_LENGTH)),
  displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(80)),
});

export type SignUpInput = v.InferOutput<typeof SignUpInputSchema>;

export const SignInInputSchema = v.strictObject({
  email: v.pipe(v.string(), v.minLength(3), v.maxLength(254)),
  // Deliberately no minimum: an account created before the current policy, or
  // with a stricter one, must still be able to sign in. Refusing short input at
  // the form would lock those users out of the very page that would fix it.
  password: v.pipe(v.string(), v.minLength(1), v.maxLength(PASSWORD_MAX_LENGTH)),
});

export type SignInInput = v.InferOutput<typeof SignInInputSchema>;

/** Body for asking for a recovery mail. Never echoes whether the address exists. */
export const PasswordResetRequestSchema = v.strictObject({
  email: v.pipe(v.string(), v.minLength(3), v.maxLength(254)),
  /**
   * Where to send the user afterwards.
   *
   * A relative path only. An absolute URL here would let a caller nominate an
   * arbitrary destination for a link that carries a credential; the server
   * resolves it against its own origin and refuses anything that leaves it.
   */
  redirectTo: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
});

export type PasswordResetRequest = v.InferOutput<typeof PasswordResetRequestSchema>;

export const PasswordResetSchema = v.strictObject({
  token: ResetTokenSchema,
  newPassword: v.pipe(
    v.string(),
    v.minLength(PASSWORD_MIN_LENGTH),
    v.maxLength(PASSWORD_MAX_LENGTH),
  ),
});

export type PasswordReset = v.InferOutput<typeof PasswordResetSchema>;

/** Uniform error envelope for every authenticated route. */
export const ApiErrorSchema = v.strictObject({
  error: v.pipe(v.string(), v.minLength(1)),
  message: v.string(),
});

export type ApiError = v.InferOutput<typeof ApiErrorSchema>;

/**
 * Read Better Auth's machine-readable code out of a caught error.
 *
 * Lives here, in the portable package, rather than in a client service or a route
 * adapter, because three places need it and two of them are on opposite sides of
 * the server plane: a form action classifies a failure the same way the ViewModel
 * does, and putting this in browser transport code would mean the server importing
 * from the browser.
 *
 * It is a plain function over `unknown` rather than a typed helper, so it works on
 * anything that was thrown without a cast. `EMAIL_NOT_VERIFIED` and a wrong
 * password are both 403, and this is the only thing that tells them apart.
 */
export const authErrorCode = (error: unknown): string | undefined => {
  const errorLike = error as { cause?: unknown; body?: unknown } | null | undefined;

  // Two shapes, because there are two callers:
  //   * an HTTP failure, where `ApiClient` put the parsed response body in `cause`
  //     — so the code is `cause.code`;
  //   * a server-side `auth.api.*` failure, where Better Auth's `APIError` carries
  //     the same object as `body` — so the code is `body.code`.
  // Checking one and not the other would make this work in a route action and
  // silently return `undefined` in a ViewModel, which is the harder failure to
  // notice because the classification then falls through to "unknown".
  for (const candidate of [errorLike?.cause, errorLike?.body]) {
    if (typeof candidate !== 'object' || candidate === null) {
      continue;
    }
    const code = (candidate as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }

  return undefined;
};

/**
 * Codes the account lifecycle can fail with, as the browser sees them.
 *
 * Named rather than free text so a view can react to a specific outcome — "that
 * link has expired" is worth offering a new one, and "sign in instead" is not the
 * same message.
 */
export const AccountErrorCode = {
  /** The token was not recognised at all: forged, truncated, or already used. */
  invalidToken: 'INVALID_TOKEN',
  /** The token was valid once and its time has passed. */
  expiredToken: 'TOKEN_EXPIRED',
  /** The address has not been confirmed yet. */
  emailNotVerified: 'EMAIL_NOT_VERIFIED',
} as const;

export type AccountErrorCodeValue = (typeof AccountErrorCode)[keyof typeof AccountErrorCode];

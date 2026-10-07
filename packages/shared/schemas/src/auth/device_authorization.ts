// packages/shared/schemas/src/auth/device_authorization.ts
//
// The device-authorization wire contract, shared by the client that polls and the
// server that issues.
//
// RFC 8628's shape, as implemented by the pinned Better Auth
// `device-authorization` plugin. Both halves are here because both are consumers
// of one server: the native client needs to know what a denial looks like, and the
// web approval screen needs to know what it is approving. A second definition of
// either is a second thing to keep correct.
//
// Closed objects, like every other schema in this package. A field the pinned
// plugin adds in a future version must be a visible "the server sent … this build
// does not understand" rather than a silently different flow — the mistake being
// prevented is a client that treats an unknown error code as "keep polling",
// because that turns a denial into an indefinite wait.

import * as v from 'valibot';

/**
 * The public client identifier.
 *
 * **Not a secret.** It is compiled into a shipped binary and read out of it by
 * anybody who unzips the app; treating it as a credential is what produces the
 * "universal client secret" a template must never ship. It exists to tell the
 * server which public client asked, so a revoked client stops being usable.
 *
 * There is no OAuth-provider expansion and no custom signed token here. The
 * `access_token` below is an ordinary Better Auth session token, verifiable by
 * the same call that verifies a cookie.
 */
export const ClientIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(64), v.regex(/^\S+$/));
export type ClientId = v.InferOutput<typeof ClientIdSchema>;

/**
 * What `POST /api/auth/device/code` answers.
 *
 * `verification_uri` is where the *user* goes; `verification_uri_complete` is the
 * same page with the code filled in. The client shows the short `user_code` so a
 * person can type it, and hands the browser the complete URL so they do not have
 * to. Both come from the server: a client that built either itself would be
 * choosing where an approval link lands.
 */
export const DeviceCodeResponseSchema = v.strictObject({
  device_code: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  /** Short code, meant to be read aloud and typed by a person. */
  user_code: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  verification_uri: v.pipe(v.string(), v.minLength(1), v.maxLength(2048)),
  verification_uri_complete: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
  expires_in: v.pipe(v.number(), v.integer(), v.finite(), v.minValue(1)),
  /** Minimum seconds between polls. The client must not poll faster. */
  interval: v.pipe(v.number(), v.integer(), v.finite(), v.minValue(1)),
});
export type DeviceCodeResponse = v.InferOutput<typeof DeviceCodeResponseSchema>;

/**
 * What `POST /api/auth/device/token` answers on success.
 *
 * `access_token` is a session token, presented afterwards as `Authorization:
 * Bearer …`. It is never a signed token this repository minted: the same server
 * verifies it that verifies a cookie, so there is one session model rather than
 * two.
 */
export const DeviceTokenResponseSchema = v.strictObject({
  access_token: v.pipe(v.string(), v.minLength(1), v.maxLength(512)),
  /** Only `"Bearer"` exists. The union is the assertion. */
  token_type: v.union([v.literal('Bearer')]),
  expires_in: v.pipe(v.number(), v.integer(), v.finite(), v.minValue(0)),
  /** Space-separated. Empty for this application, which grants no scopes. */
  scope: v.pipe(v.string(), v.maxLength(512)),
});
export type DeviceTokenResponse = v.InferOutput<typeof DeviceTokenResponseSchema>;

/**
 * The four non-success answers the token endpoint gives, all HTTP 400.
 *
 * They are four different situations and a client that collapsed them would be
 * wrong three times out of four:
 *
 *   - `authorization_pending` — nobody has decided yet. Poll again after `interval`.
 *   - `slow_down` — polled too fast. Increase the interval by five seconds, as
 *     RFC 8628 says, and poll again. Treating it as a failure ends a sign-in that
 *     was about to succeed.
 *   - `expired_token` — the device code is past `expires_in`. Start over.
 *   - `access_denied` — somebody pressed Deny. Never retry this one.
 */
export const DEVICE_TOKEN_ERRORS = [
  'authorization_pending',
  'slow_down',
  'expired_token',
  'access_denied',
] as const;
export type DeviceTokenError = (typeof DEVICE_TOKEN_ERRORS)[number];

export const DeviceTokenErrorResponseSchema = v.strictObject({
  error: v.union(DEVICE_TOKEN_ERRORS.map((code) => v.literal(code))),
  error_description: v.optional(v.pipe(v.string(), v.maxLength(512))),
});
export type DeviceTokenErrorResponse = v.InferOutput<typeof DeviceTokenErrorResponseSchema>;

/** `verification_uri` this application's server is configured to hand out. */
export const DEVICE_VERIFICATION_PATH = '/device';

/**
 * The polling pace this client starts at, in milliseconds.
 *
 * The server's own `interval` wins whenever it is larger — it is the authority,
 * and a client that polls faster is the bug RFC 8628's `slow_down` exists for.
 * This is only the floor for a server that answers without one.
 */
export const MIN_DEVICE_POLL_INTERVAL_MS = 5_000;

/** RFC 8628 §3.5: a `slow_down` adds five seconds to the interval. */
export const SLOW_DOWN_INCREMENT_MS = 5_000;

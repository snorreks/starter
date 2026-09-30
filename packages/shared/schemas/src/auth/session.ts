// packages/shared/schemas/src/auth/session.ts
//
// The authenticated-user shape shared by the Worker, the client and the tests.
// Round 1 enables email + password only: no OAuth, no email verification, no
// password reset. Those are documented as unsupported rather than stubbed.

import { Type, type Static } from '@sinclair/typebox';
import { UserIdSchema } from '../common/ids.ts';

export const SESSION_USER_SCHEMA_VERSION = 1 as const;

export const SessionUserSchema = Type.Object({
  id: UserIdSchema,
  email: Type.String({ minLength: 3 }),
  displayName: Type.String({ minLength: 1 }),
  /** Only `"email"` exists in round 1. The union keeps the door open. */
  provider: Type.Union([Type.Literal('email')]),
}, { additionalProperties: false });

export type SessionUser = Static<typeof SessionUserSchema>;

export const SignUpInputSchema = Type.Object({
  email: Type.String({ minLength: 3, maxLength: 254 }),
  password: Type.String({ minLength: 8, maxLength: 128 }),
  displayName: Type.String({ minLength: 1, maxLength: 80 }),
}, { additionalProperties: false });

export type SignUpInput = Static<typeof SignUpInputSchema>;

export const SignInInputSchema = Type.Object({
  email: Type.String({ minLength: 3, maxLength: 254 }),
  password: Type.String({ minLength: 1, maxLength: 128 }),
}, { additionalProperties: false });

export type SignInInput = Static<typeof SignInInputSchema>;

/** Uniform error envelope for every authenticated route. */
export const ApiErrorSchema = Type.Object({
  error: Type.String({ minLength: 1 }),
  message: Type.String(),
}, { additionalProperties: false });

export type ApiError = Static<typeof ApiErrorSchema>;

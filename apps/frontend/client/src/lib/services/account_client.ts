// apps/frontend/client/src/lib/services/account_client.ts
//
// Transport for the three endpoints that are neither sign-in nor sign-out.
//
// Split out from `api_client.ts` because those three have a property it does not:
// **each one may cause mail to be sent.** Better Auth's built-in limiter allows
// three per minute per IP for `/request-password-reset` and
// `/send-verification-email`, so a screen that retries any of these automatically
// is a way for one impatient user to lock themselves out of their own recovery
// mail. Nothing in this file retries, ever.
//
// The one thing every caller needs is `authErrorCode`, because "your address is
// not confirmed" and "your password is wrong" arrive as the same HTTP status with
// different bodies, and the second must never be reported for the first.

import type { PasswordResetRequest } from '@starter/schemas/auth';
import { AppError } from '@starter/utils';
import type { ApiClient } from './api_client.ts';

export interface VerificationRequest {
  email: string;
}

export interface PasswordResetInput {
  token: string;
  newPassword: string;
}

/**
 * Ask for a recovery email.
 *
 * The `redirectTo` must be a **relative path**, and that is enforced here rather
 * than trusted from the caller. Better Auth validates it against `trustedOrigins`,
 * but refusing to build the request at all means a compromised or careless screen
 * cannot nominate `https://attacker.example` as the destination for a link that
 * carries a credential. `//evil.example` is rejected too: it parses as a relative
 * URL but navigates cross-origin.
 */
export const requestPasswordReset = async (
  api: ApiClient,
  input: PasswordResetRequest,
): Promise<void> => {
  if (!input.redirectTo.startsWith('/') || input.redirectTo.startsWith('//')) {
    throw new AppError(
      'validation',
      'The recovery destination must be a path on this site, not another address.',
    );
  }

  await api.post('/api/auth/request-password-reset', input);
};

/**
 * Set a new password from a recovery token.
 *
 * Better Auth consumes the token as it validates it, so a second call with the
 * same token fails. That is the desired behaviour — a link that works twice is a
 * link still sitting in somebody's inbox — so this does not retry.
 */
export const resetPassword = async (api: ApiClient, input: PasswordResetInput): Promise<void> => {
  await api.post('/api/auth/reset-password', input);
};

/**
 * Ask for another confirmation link.
 *
 * `callbackURL` is a constant, not a parameter. It points at this application's
 * own `/verify-email`, where the result is read back from the server's session
 * rather than assumed from the URL. Accepting it from a caller would let a screen
 * point the confirmation bounce — and therefore the one link that proves control of
 * an address — at any origin it liked.
 */
export const sendVerificationEmail = async (
  api: ApiClient,
  input: VerificationRequest,
): Promise<void> => {
  await api.post('/api/auth/send-verification-email', {
    email: input.email,
    callbackURL: '/verify-email',
  });
};

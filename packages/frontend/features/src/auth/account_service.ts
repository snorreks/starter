// packages/frontend/features/src/auth/account_service.ts
//
// Transport for account lifecycle endpoints, separate from session state.
//
// Mail-producing requests are subject to application and provider rate limits.
// Retrying automatically can duplicate mail or lock a user out of recovery.
// Nothing in this file retries, ever.
//
// The one thing every caller needs is `authErrorCode`, because "your address is
// not confirmed" and "your password is wrong" arrive as the same HTTP status with
// different bodies, and the second must never be reported for the first.

import type { ApiTransport } from '@starter/platform';
import type { PasswordResetRequest } from '@starter/schemas/auth';
import { AppError } from '@starter/utils';

export interface VerificationRequest {
  email: string;
}

export interface PasswordResetInput {
  token: string;
  newPassword: string;
}

/** The account lifecycle endpoints a client screen may call. */
export interface AccountService {
  /** Ask for a recovery email. Refuses a destination that leaves this site. */
  requestPasswordReset(input: PasswordResetRequest): Promise<void>;
  /** Set a new password from a recovery token. */
  resetPassword(input: PasswordResetInput): Promise<void>;
  /** Ask for another confirmation link. */
  sendVerificationEmail(input: VerificationRequest): Promise<void>;
  /** Ask the account API to start its verified email-change flow. */
  changeEmail(input: { email: string }): Promise<void>;
  /** Delete the currently authenticated account. */
  deleteAccount(): Promise<void>;
}

/**
 * The account endpoints, over whatever transport the host injected.
 *
 * The rules below are host-independent, which is exactly why they live here rather
 * than in either composition root: a native host that got them wrong would mail a
 * recovery link to an attacker's address.
 */
export const createAccountService = (transport: ApiTransport): AccountService => ({
  /**
   * Ask for a recovery email.
   *
   * The `redirectTo` must be a **relative path**, and that is enforced here rather
   * than trusted from the caller. The account API also validates the destination
   * against the host's allowed origins. Refusing an absolute destination here
   * prevents a screen from nominating `https://attacker.example` for a link that
   * carries a credential. `//evil.example` is rejected too: it parses as a relative
   * URL but navigates cross-origin.
   */
  async requestPasswordReset(input) {
    if (!input.redirectTo.startsWith('/') || input.redirectTo.startsWith('//')) {
      throw new AppError(
        'validation',
        'The recovery destination must be a path on this site, not another address.',
      );
    }

    await transport.request<unknown>('/api/auth/request-password-reset', {
      method: 'POST',
      body: input,
    });
  },

  /**
   * Set a new password from a recovery token.
   *
   * The account API owns validation and consumption of the recovery credential.
   * This client never retries a credential-bearing mutation automatically.
   */
  async resetPassword(input) {
    await transport.request<unknown>('/api/auth/reset-password', { method: 'POST', body: input });
  },

  /**
   * Ask for another confirmation link.
   *
   * `callbackURL` is a constant, not a parameter. It points at this application's
   * own `/verify-email`, where the result is read back from the server's session
   * rather than assumed from the URL. Accepting it from a caller would let a screen
   * point the confirmation bounce — and therefore the one link that proves control
   * of an address — at any origin it liked.
   *
   * The path is a constant rather than a parameter for the same reason: a caller
   * that could choose the callback would choose where a credential-carrying link
   * lands. A host that does not serve `/verify-email` implements `AccountService`
   * itself rather than passing a different path here — the interface is the seam,
   * and widening it to "wherever you want the user to end up" would put the rule
   * back in the caller's hands.
   */
  async sendVerificationEmail(input) {
    await transport.request<unknown>('/api/auth/send-verification-email', {
      method: 'POST',
      body: { email: input.email, callbackURL: VERIFICATION_RETURN_PATH },
    });
  },

  async changeEmail(input) {
    await transport.request<unknown>('/api/auth/account/email-change', {
      method: 'POST',
      body: input,
    });
  },

  async deleteAccount() {
    await transport.request<unknown>('/api/auth/account/delete', { method: 'POST', body: {} });
  },
});

/**
 * Where the confirmation link brings a user back to.
 *
 * A path, not a URL: the account API resolves it against the application's origin.
 * An absolute URL here would request that a credential be delivered to an
 * address this build does not control.
 */
export const VERIFICATION_RETURN_PATH = '/verify-email';

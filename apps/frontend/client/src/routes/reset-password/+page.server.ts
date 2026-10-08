// apps/frontend/client/src/routes/reset-password/+page.server.ts
//
// Set a new password from a recovery link.
//
// GoTrue consumes the mail credential, then the application callback exchanges
// its single-use PKCE code for a session. The reset form requires that verified
// session and a short-lived, same-user callback marker; query tokens are not proof.
// A successful reset consumes the marker and signs out globally. Supabase revokes
// refresh tokens; already issued access tokens remain valid until their expiry.
// No recovery credential is rendered into the form or written to a log.

import {
  AccountErrorCode,
  authErrorCode,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@starter/schemas/auth';
import { toAppError } from '@starter/utils';
import { fail, redirect } from '@sveltejs/kit';
import { submitAuthAction } from '#lib/server/auth_action.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals, cookies }) => {
  // `?sent=1` means "we have already asked", arriving from the forgot form. No token
  // yet, and no form to show.
  if (url.searchParams.get('sent') === '1') {
    return { sent: true, hasToken: false };
  }

  if (
    !locals.user ||
    cookies.get('starter-recovery-user') !== locals.user.id ||
    url.searchParams.has('invalid')
  ) {
    return { sent: false, hasToken: false };
  }

  return {
    sent: false,
    hasToken: true,
    // The address is needed only to greet the user, and it comes from the server's own
    // session — never from the URL. A token that named its own account would be a
    // second thing to trust, and this page has no way to verify one.
    email: locals.user?.email ?? null,
  };
};

export const actions: Actions = {
  default: async ({ request, url, locals, cookies }) => {
    const form = await request.formData();
    const newPassword = String(form.get('newPassword') ?? '');

    if (
      !locals.user ||
      cookies.get('starter-recovery-user') !== locals.user.id ||
      url.searchParams.has('invalid')
    ) {
      return fail(400, {
        tokenInvalid: true,
        errors: { newPassword: 'That link is no longer valid. Ask for a new one.' },
      });
    }

    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      return fail(422, {
        tokenInvalid: false,
        errors: { newPassword: `Use at least ${PASSWORD_MIN_LENGTH} characters.` },
      });
    }
    if (newPassword.length > PASSWORD_MAX_LENGTH) {
      return fail(422, {
        tokenInvalid: false,
        errors: { newPassword: `Use at most ${PASSWORD_MAX_LENGTH} characters.` },
      });
    }

    try {
      await submitAuthAction(
        locals.container,
        request,
        cookies,
        'reset-password',
        {
          newPassword,
        },
        locals.context?.responseHeaders ?? null,
      );
    } catch (error) {
      const appError = toAppError(error);
      if (appError.errorType === 'rate_limited') {
        return fail(429, {
          tokenInvalid: false,
          errors: { newPassword: 'Too many requests. Wait a minute and try again.' },
        });
      }
      const code = authErrorCode(error);
      const tokenInvalid =
        code === AccountErrorCode.invalidToken || code === AccountErrorCode.expiredToken;
      let passwordErrorMessage = appError.message;
      if (code === AccountErrorCode.expiredToken) {
        passwordErrorMessage = 'That link has expired. Ask for a new one.';
      } else if (code === AccountErrorCode.invalidToken) {
        passwordErrorMessage = 'That link is no longer valid. It may already have been used.';
      }

      // Token errors collapse into two messages on purpose. A user cannot act on
      // the difference between "forged" and "already used" — for both, the fix is
      // a new link — and distinguishing them would confirm that a token they hold
      // was once valid.
      return fail(400, {
        tokenInvalid,
        errors: {
          newPassword: passwordErrorMessage,
        },
      });
    }

    // Signed out, deliberately. Every session was just revoked, including this
    // browser's, and pretending otherwise would leave the shell showing a user
    // with no session.
    cookies.delete('starter-recovery-user', { path: '/reset-password' });
    redirect(303, '/login?reset=1');
  },
};

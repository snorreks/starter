// apps/frontend/client/src/routes/verify-email/+page.server.ts
//
// Where the verification link lands, and where it can be re-requested.
//
// The link a user clicks is
// `<origin>/api/auth/verify-email?token=<jwt>&callbackURL=%2Fverify-email`.
// Supabase Auth validates the token **before** redirecting here, so arriving at this
// page with no `error` means the address is confirmed. Two things this route adds:
//
//   - **It reads the outcome from the server's own state, not from the URL.** A
//     bare visit — someone typing `/verify-email`, or a second click on an already
//     used link — also arrives with no `error`. So the page asks the session what
//     it actually knows instead of assuming success. A page that says "verified"
//     because nothing told it otherwise is a page that congratulates someone whose
//     address is not verified.
//   - **Re-sending is a POST**, so it cannot be triggered by a prefetcher or a
//     `<img src>`. Supabase Auth's built-in limiter allows three per minute per IP
//     for this endpoint, and a GET that sends mail would let anyone exhaust another
//     person's recovery budget by loading a page.

import { AccountErrorCode } from '@starter/schemas/auth';
import { toAppError } from '@starter/utils';
import { fail } from '@sveltejs/kit';
import { submitAuthAction } from '#lib/server/auth_action.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
  // Supabase Auth redirects here *after* confirming the address, appending an error
  // only on failure — and only when a `callbackURL` was supplied, which
  // `#lib/services/account_client.ts` always does. So a bare `null` here means the
  // token was accepted.
  const error = url.searchParams.get('error');

  return {
    error,
    expired: error?.includes(AccountErrorCode.expiredToken) === true,
    // `null` when nobody is signed in, which is the normal case: confirming an address
    // does not sign anyone in. That is why this cannot be the only signal — there is
    // often no session to read the answer from.
    verified: locals.user?.emailVerified ?? false,
    email: locals.user?.email ?? null,
  };
};

export const actions: Actions = {
  default: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    const email = String(form.get('email') ?? '').trim();

    if (email.length === 0) {
      return fail(422, { error: 'Enter your email address.' });
    }

    try {
      await submitAuthAction(
        locals.container,
        request,
        cookies,
        'send-verification-email',
        {
          email,
        },
        locals.context?.responseHeaders ?? null,
      );
    } catch (error) {
      const appError = toAppError(error, 'Could not send that email.');
      if (appError.errorType === 'rate_limited') {
        return fail(429, { error: 'Too many requests. Wait a minute and try again.' });
      }
      // A send failure is reported; an unknown address is not. Supabase Auth's
      // enumeration protection means both look the same from here.
      return fail(502, { error: 'We could not send that email just now.' });
    }

    return { sent: true };
  },
};

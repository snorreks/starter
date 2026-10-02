// apps/frontend/client/src/routes/forgot-password/+page.server.ts
//
// Ask for a recovery email.
//
// This is a form action and not a client service, because the page has to work
// with JavaScript disabled — and because the interesting behaviour here is what
// the response does **not** say.
//
// Sign-in tells the user their credentials were wrong. This must not, ever. An
// attacker who can submit an address learns from the difference between "we sent
// you a link" and "no such account" whether the address is registered. So the
// response is byte-identical either way, and the mail is only sent when an account
// exists.
//
// `redirectTo` is not taken from the request. It is a constant. The parameter is
// what a recovery link's destination would otherwise be, and accepting it from a
// caller would mean a link carrying a credential can be pointed at any origin the
// caller names. The destination is this route, decided here.

import { toAppError } from '@starter/utils';
import { fail, redirect } from '@sveltejs/kit';
import { submitAuthAction } from '#lib/server/auth_action.ts';
import type { Actions } from './$types';

export const actions: Actions = {
  default: async ({ request, locals, cookies }) => {
    const form = await request.formData();
    const email = String(form.get('email') ?? '').trim();

    if (email.length === 0) {
      return fail(422, { errors: { email: 'Enter your email address.' } });
    }

    try {
      // Better Auth's own enumeration protection: a request for an unknown
      // address returns success without sending anything.
      await submitAuthAction(locals.container, request, cookies, 'request-password-reset', {
        email,
        redirectTo: '/reset-password',
      });
    } catch (error) {
      const appError = toAppError(error, 'Could not send that email.');
      // Only a genuine configuration or transport failure is reported. A "no such
      // user" answer is *not* — it has to look identical to success, or this
      // endpoint becomes the enumeration oracle the design exists to avoid.
      if (appError.errorType === 'rate_limited') {
        return fail(429, { message: 'Too many requests. Wait a minute and try again.' });
      }
      return fail(502, {
        message: 'We could not send that email just now. Try again in a minute.',
      });
    }

    // `303` so a reload of this URL is a GET rather than a second send. That is
    // what stops a double submission from asking for two emails.
    redirect(303, '/reset-password?sent=1');
  },
};

// apps/frontend/client/src/routes/reset-password/+page.server.ts
//
// Set a new password from a recovery link.
//
// The link a user clicks is
// `<origin>/api/auth/reset-password/<token>?callbackURL=%2Freset-password`.
// Supabase Auth validates that token **first** and only then redirects to the callback
// with `?token=`, so this page is reached with a token that was real a moment ago. It
// can still be expired or consumed by the time the form is submitted, which is why
// the action treats "invalid token" as an expected answer with its own message rather
// than a crash.
//
// Why the token is a **query parameter** here and not a path segment: Supabase Auth
// chooses that shape, and its callback handler appends the token itself. A route
// written to expect `/reset-password/<token>` would 404 on every link the library
// ever sends.
//
// Three properties this route has to get right:
//
//   - **Token is single-use.** Supabase Auth consumes it as it validates. A second
//     submission fails, which is correct: a link that works twice is a link still
//     sitting in somebody's inbox.
//   - **A reset ends every session.** `revokeSessionsOnPasswordReset` is set in the
//     auth config. The scenario is somebody else holding a session cookie, and the
//     owner resetting their password expects them locked out.
//   - **The token is not logged.** Nothing here writes it, and `console` output from
//     this process is captured by `bun run logs`; the form has no `action`, so the
//     token is not echoed back into the rendered HTML either.

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

export const load: PageServerLoad = async ({ url, locals }) => {
  // `?sent=1` means "we have already asked", arriving from the forgot form. No token
  // yet, and no form to show.
  if (url.searchParams.get('sent') === '1') {
    return { sent: true, hasToken: false };
  }

  const token = url.searchParams.get('token');
  if (token === null || token.length === 0) {
    // A bare visit. Someone typed the URL, or followed a link whose token Supabase Auth
    // declined to forward. Either way there is nothing to submit.
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

    // The token comes from the URL the link pointed at, not from a form field. A field
    // is attacker-controlled; the URL is what Supabase Auth's callback validated before
    // it redirected here.
    const token = url.searchParams.get('token') ?? '';

    if (newPassword.length < PASSWORD_MIN_LENGTH) {
      return fail(422, {
        errors: { newPassword: `Use at least ${PASSWORD_MIN_LENGTH} characters.` },
      });
    }
    if (newPassword.length > PASSWORD_MAX_LENGTH) {
      return fail(422, {
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
          token,
        },
        locals.context?.responseHeaders ?? null,
      );
    } catch (error) {
      if (toAppError(error).errorType === 'rate_limited') {
        return fail(429, {
          errors: { newPassword: 'Too many requests. Wait a minute and try again.' },
        });
      }
      const code = authErrorCode(error);

      // Three codes collapse into two messages on purpose. A user cannot act on
      // the difference between "forged" and "already used" — for both, the fix is
      // a new link — and distinguishing them would confirm that a token they hold
      // was once valid.
      return fail(400, {
        errors: {
          newPassword:
            code === AccountErrorCode.expiredToken
              ? 'That link has expired. Ask for a new one.'
              : 'That link is no longer valid. It may already have been used.',
        },
      });
    }

    // Signed out, deliberately. Every session was just revoked, including this
    // browser's, and pretending otherwise would leave the shell showing a user
    // with no session.
    redirect(303, '/login?reset=1');
  },
};

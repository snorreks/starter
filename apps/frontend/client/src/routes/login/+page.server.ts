// apps/frontend/client/src/routes/login/+page.server.ts
//
// The form action behind the sign-in and sign-up form.
//
// This exists for one reason: **it must work with JavaScript disabled.** Every
// other path in this flow is a client service, and a client service is invisible
// to a browser that did not run any. A form action is the only way a submission
// reaches the server that is not a `fetch`.
//
// Both branches converge on the same Better Auth endpoints the browser calls
// directly. There is no second authorization rule here and no second place where a
// session is created: this calls `auth.handler`, including the middleware used
// by `/api/auth/[...all]`.
//
// What it does with a success depends on which success. A sign-in redirects, because
// the only thing that can act on a session in a browser that never ran this page's
// script is the browser itself. A sign-up returns an outcome instead, because the next
// step happens in an inbox and the message has to be *shown*, not navigated away from.
// A client submission never reaches this file at all: with scripting on, the ViewModel
// calls the HTTP auth endpoints and the ViewModel navigates.

import {
  AccountErrorCode,
  authErrorCode,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@starter/schemas/auth';
import { toAppError } from '@starter/utils';
import { error, fail, redirect } from '@sveltejs/kit';
import { submitAuthAction } from '#lib/server/auth_action.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * Pre-fill the form on a re-render.
 *
 * The mode-switch button is a form submission so that it works without scripting, and
 * a submission's whole purpose is to come back as a page. The address is carried in the
 * query so switching modes does not make someone retype it — the common path is "typed
 * an address, then realised it is not signed up yet".
 */
export const load: PageServerLoad = async ({ url }) => {
  const mode = url.searchParams.get('mode');
  const email = url.searchParams.get('email') ?? '';

  return {
    mode: mode === 'sign-up' ? ('sign-up' as const) : ('sign-in' as const),
    email,
  };
};

export const actions: Actions = {
  default: async ({ request, cookies, locals }) => {
    const form = await request.formData();

    // Read *before* anything else, because this is the one request that is not a
    // submission. The mode switch is a submitter carrying its own `toggle` field, so
    // its presence is unambiguous: a pressed submitter does not replace a form field of
    // the same name, it adds to the payload, which is why this cannot be an `intent`
    // value — `FormData.get('intent')` would return the form's own hidden field and
    // report the press as an ordinary sign-in.
    if (form.has('toggle')) {
      const email = String(form.get('email') ?? '').trim();
      const intent = form.get('intent');
      const next = intent === 'sign-in' ? 'sign-up' : 'sign-in';
      // `303` so a reload of the result is a GET, not another toggle.
      redirect(
        303,
        `/login?mode=${next}${email.length > 0 ? `&email=${encodeURIComponent(email)}` : ''}`,
      );
    }

    const email = String(form.get('email') ?? '').trim();
    const password = String(form.get('password') ?? '');
    const displayName = String(form.get('name') ?? '').trim();
    // `intent` is the form's own mode field: the hidden input that says which of the two
    // forms is being submitted.
    const intent = String(form.get('intent') ?? 'sign-in');

    const errors: Record<string, string> = {};
    if (email.length === 0) {
      errors.email = 'Enter your email address.';
    }
    if (password.length === 0) {
      errors.password = 'Enter your password.';
    } else if (intent === 'sign-up' && password.length < PASSWORD_MIN_LENGTH) {
      // Only on sign-up. A short password is refused at creation, not at sign-in,
      // because refusing it at sign-in locks out accounts that predate the policy.
      errors.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
    } else if (password.length > PASSWORD_MAX_LENGTH) {
      errors.password = `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
    }
    if (intent === 'sign-up' && displayName.length === 0) {
      errors.name = 'Enter a name.';
    }

    if (Object.keys(errors).length > 0) {
      // `422` rather than `400`: nothing is malformed, the request is
      // well-formed and refused. And the values are echoed so a no-JS submit does
      // not clear the form — an error page with empty boxes is the classic
      // no-JS regression.
      return fail(422, { errors, values: { email, displayName } });
    }

    const result = await attemptCredentials(locals.container, request, cookies, {
      intent,
      email,
      password,
      displayName,
    });

    if (result.kind === 'refused') {
      return fail(result.status, { errors: result.errors });
    }

    if (result.kind === 'signed-in') {
      // The helper applied response cookies before this redirect, which throws.
      // Require a cookie so a successful sign-in cannot silently lose its session.
      if (result.cookies === 0) {
        // Better Auth reported success and set no session. Failing loudly beats a
        // redirect to a page that bounces straight back here, which is what a
        // zero-cookie sign-in otherwise produces.
        error(500, 'Could not start a session. Try again.');
      }

      // `303` because `POST` must not redirect to `GET` implicitly, and the browser
      // holds the cookie by the time it follows this.
      //
      // The path is a literal rather than `AUTHENTICATED_PATH`, which lives in the
      // browser half of the feature and the server half cannot import. Two spellings of
      // one URL is a smaller problem than the import boundary it would cost.
      redirect(303, '/notes');
    }

    // The one outcome that is returned rather than navigated to, because there is
    // nowhere to go: the account exists, the address is unconfirmed, and the next step
    // happens in an inbox. It is also the one value a browser that never ran this page's
    // script can still be *shown* — `+page.svelte` assigns it beside the view model
    // rather than in an effect, because an effect does not run during SSR.
    return { outcome: { kind: 'awaiting-verification', email } };
  },
};

/** The slice of Better Auth this action calls, taken from the container it comes from. */
type AuthContainer = App.Locals['container'];

/**
 * What one attempt at the credentials produced.
 *
 * A union rather than a thrown error, because the caller has to act on the three
 * outcomes differently: a refusal becomes a `fail`, a session becomes a redirect, and a
 * sign-up becomes a message on a page that stays where it is. One return value keeps all
 * three visible at the call site.
 */
type AuthAttempt =
  /** Signed in. `cookies` counts the response cookies applied to the browser. */
  | { kind: 'signed-in'; cookies: number }
  /** Account created; nothing to navigate to and nothing to store. */
  | { kind: 'signed-up' }
  | { kind: 'refused'; status: number; errors: Record<string, string> };

/**
 * Run the credentials against Better Auth, turning a rejection into a refusal.
 *
 * A helper so the `try` that catches Better Auth's rejections cannot also swallow the
 * `redirect` that follows a successful sign-in — both throw, and an action whose single
 * `try` covers both turns every success into a 400.
 */
const attemptCredentials = async (
  container: AuthContainer,
  request: Request,
  cookies: Parameters<typeof submitAuthAction>[2],
  credentials: { intent: string; email: string; password: string; displayName: string },
): Promise<AuthAttempt> => {
  try {
    const signingUp = credentials.intent === 'sign-up';
    const applied = await submitAuthAction(
      container,
      request,
      cookies,
      signingUp ? 'sign-up/email' : 'sign-in/email',
      {
        email: credentials.email,
        password: credentials.password,
        ...(signingUp ? { name: credentials.displayName } : {}),
      },
    );
    return signingUp ? { kind: 'signed-up' } : { kind: 'signed-in', cookies: applied };
  } catch (error) {
    return {
      kind: 'refused',
      status: toAppError(error).errorType === 'rate_limited' ? 429 : 400,
      errors: classify(error),
    };
  }
};

/**
 * Field errors and a single message, so the view has nothing to interpret.
 *
 * Better Auth's own text is not forwarded. For sign-in it distinguishes a wrong
 * password from an unknown address, and passing that through turns this form into
 * a way to discover which addresses have accounts.
 */
const classify = (error: unknown): Record<string, string> => {
  const appError = toAppError(error, 'Could not complete that request.');

  // The code is read before the status, for the same reason it is in the
  // ViewModel: an unverified address arrives as 403, the same status as a wrong
  // password, and telling someone to check their inbox when their password is
  // wrong leaves them waiting for a mail that never comes.
  if (authErrorCode(error) === AccountErrorCode.emailNotVerified) {
    return { _: 'Confirm your address first. Check your inbox, or request a new link.' };
  }
  if (appError.errorType === 'forbidden' || appError.errorType === 'unauthorized') {
    return { _: 'That email and password do not match an account.' };
  }
  if (appError.errorType === 'rate_limited') {
    return { _: 'Too many attempts. Wait a minute and try again.' };
  }
  return { _: appError.message };
};

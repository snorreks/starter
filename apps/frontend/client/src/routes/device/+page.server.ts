// apps/frontend/client/src/routes/device/+page.server.ts
//
// Where a user approves a native client, in a browser that already holds their
// account.
//
// Why this is a web page at all
// -----------------------------
// The native app cannot show the approval: it has no password, no session, and no
// business displaying somebody's login form inside its own chrome. So the device
// flow sends the *user* to this origin, in their own browser, and the client waits
// by polling. That is RFC 8628's shape, and it is also the only way a sign-in
// happens without this application ever seeing a password typed into a desktop
// window.
//
// Four properties this file owns:
//
//   1. **A signed-in session is required, and the code is read back from the
//      server.** `readDeviceAuthorization` is not optional: it is the call that
//      *claims* the code for this session, and without it the approve endpoint
//      answers 403 with a message about claiming that a user could do nothing
//      about. It also means this page never renders a code it was handed by the
//      URL alone — the server decides whether it exists and what state it is in.
//   2. **Approve and deny are form actions, not fetch calls.** They go through
//      `submitDeviceAction`, which re-issues them through `auth.handler` so the
//      origin check and the rate limiter still apply — see `auth_action.ts`.
//   3. **The outcome is re-read from the server after the action.** A redirect to a
//      page that reports "approved" from the action's own return value would be a
//      claim this application made about itself; the load re-asks.
//   4. **An anonymous visitor is redirected, not shown an empty page.** An
//      approval screen with no session is a dead end that reads as a bug.

import { fail, redirect } from '@sveltejs/kit';
import {
  type DeviceActionPath,
  readDeviceAuthorization,
  submitDeviceAction,
} from '#lib/server/auth_action.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * Bound on what a user code may look like before it is sent anywhere.
 *
 * The plugin generates an eight-character code, and this is a refusal rather than
 * a truncation: a longer value is either a mistake or something that was not a
 * code, and passing it on would put an unbounded string into a query the server
 * then logs.
 */
const MAX_USER_CODE_LENGTH = 64;

/** Read the code the user arrived with, or null when there is not a usable one. */
const readUserCode = (url: URL): string | null => {
  const raw = url.searchParams.get('user_code')?.trim() ?? '';
  if (raw.length === 0 || raw.length > MAX_USER_CODE_LENGTH) {
    return null;
  }
  return raw;
};

/**
 * The decision this page already made in this visit.
 *
 * Read from the URL because the actions end in a redirect: the load re-runs, the
 * code's real state comes back from the server, and this is the one thing the
 * redirect adds. Validated against a closed set rather than interpolated, so a
 * crafted URL cannot put arbitrary text into the screen's copy.
 */
const readOutcome = (url: URL): string | null => {
  const decided = url.searchParams.get('decided');
  return decided === 'device/approve' || decided === 'device/deny' ? decided : null;
};

export const load: PageServerLoad = async ({ locals, request, url }) => {
  if (locals.user === null) {
    redirect(303, '/login');
  }

  const outcome = readOutcome(url);
  const userCode = readUserCode(url);
  if (userCode === null) {
    return { userCode: null, state: null, outcome };
  }

  const state = await readDeviceAuthorization(locals.container, request, userCode);

  return { userCode, state, outcome };
};

const decide = (path: DeviceActionPath) => {
  return async ({ locals, request, cookies, url }: Parameters<Actions[string]>[0]) => {
    if (locals.user === null) {
      redirect(303, '/login');
    }

    const userCode = readUserCode(url);
    if (userCode === null) {
      return fail(400, { outcome: 'No device code was supplied.' });
    }

    try {
      await submitDeviceAction(locals.container, request, cookies, path, userCode);
    } catch {
      // Better Auth's own status is carried on the AppError; the message is this
      // application's, because the provider's distinguishes an expired code from
      // an unknown one and forwarding that would make this page an oracle for
      // guessing codes.
      return fail(400, {
        outcome:
          path === 'device/approve'
            ? 'That request could not be approved. It may have expired or already been decided.'
            : 'That request could not be denied. It may have expired or already been decided.',
      });
    }

    // Re-read rather than assert. See property 3 in the header.
    redirect(303, `/device?user_code=${encodeURIComponent(userCode)}&decided=${path}`);
  };
};

export const actions: Actions = {
  approve: decide('device/approve'),
  deny: decide('device/deny'),
};

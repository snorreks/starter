// apps/frontend/client/src/lib/server/dev_auto_login.ts
//
//   bun run dev   # seeds a synthetic account, then signs in as it
//
// `bun run dev` starts a local Supabase stack it owns, seeds one synthetic
// account into it, and writes three bindings naming that account. When all three
// are present — and only then — a request that carries no session is signed in
// as that account before the route runs. So the local loop is: change a file,
// reload, and you are looking at your own notes rather than a sign-in form.
//
// **This is a development convenience and it fails closed on both sides.** The
// launcher writes the bindings only for a stack it started itself; this module
// refuses unless `SUPABASE_URL` is unambiguously this machine *and* the
// deployment was already classified local. A deployed Worker has neither, so the
// same code that signs a developer in cannot sign anyone else in — and the
// password it presents is public by construction, which is precisely why nothing
// will use it against a remote project.
//
// Three things it will not do:
//
//   * **Run against a project the developer named.** `bun run dev` with
//     `SUPABASE_URL` set writes no bindings, so the E2E lane and a deliberate
//     hosted-project run are unaffected.
//   * **Undo a sign-out.** Without a marker, signing out would bounce the next
//     page load straight back in, and "sign out" would read as broken. So
//     signing out records the decision; `/login` offers it back explicitly.
//   * **Touch the API.** Sign-in is a page-load concern. An `/api/*` request gets
//     the session it arrived with, which is also what keeps the sign-out endpoint
//     able to sign you out.
//
// A failure here is never a failed request: if Supabase Auth refuses the seeded
// credentials, the request continues anonymously and the hook logs why. A
// development convenience must not be the reason a page returns 500.

import type { Cookies } from '@sveltejs/kit';
import { submitAuthAction } from './auth_action.ts';
import type { Container } from './container.ts';
import { type AppEnv, isLoopbackHttpUrl } from './env.ts';
import { isApiPath } from './http.ts';

/**
 * The only value that enables this. Not `true`, not `1`, not `yes`: a boolean-ish
 * flag here would eventually be set by something that did not mean it.
 */
export const DEV_AUTO_LOGIN_MODE = 'seed';

export const DEV_AUTO_LOGIN_BINDING = 'DEV_AUTO_LOGIN';
export const DEV_AUTO_LOGIN_EMAIL_BINDING = 'DEV_AUTO_LOGIN_EMAIL';
export const DEV_AUTO_LOGIN_PASSWORD_BINDING = 'DEV_AUTO_LOGIN_PASSWORD';

/**
 * Records that this browser asked to be signed out.
 *
 * `httpOnly`, because only the server may clear it: the reset is a deliberate act
 * through the sign-in form, not something a script on the page can undo by
 * accident. Not `secure`, because the local stack is plain http and a secure
 * cookie would never be stored on `http://127.0.0.1`.
 */
export const DEV_SIGNED_OUT_COOKIE = 'starter-dev-signed-out';

/** The sign-in form's intent value that hands the session back to auto sign-in. */
export const DEV_AUTO_SIGN_IN_INTENT = 'dev-auto-signin';

/**
 * The seeded account, as `submitAuthAction` takes a body.
 *
 * `Record<string, string>` because that is the shape every auth action accepts;
 * the named fields are what the caller reads, and the two cannot disagree because
 * they are the same object.
 */
export interface DevAutoSignInAccount extends Record<string, string> {
  email: string;
  password: string;
}

/** A trimmed binding value, or `undefined` when it is absent or blank. */
const binding = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

/**
 * The account this request may be signed in as, or `null` for every reason not to.
 *
 * Separate from the sign-in itself so the rule is assertable without a container,
 * a cookie jar or an auth provider — the refusals are the whole point of this
 * module, and a rule that can only be observed by signing in successfully is a
 * rule nobody can change safely.
 */
export const devAutoSignInFor = (
  env: Partial<AppEnv>,
  isLocal: boolean,
): DevAutoSignInAccount | null => {
  if (binding(env[DEV_AUTO_LOGIN_BINDING]) !== DEV_AUTO_LOGIN_MODE) {
    return null;
  }
  const email = binding(env[DEV_AUTO_LOGIN_EMAIL_BINDING]);
  const password = binding(env[DEV_AUTO_LOGIN_PASSWORD_BINDING]);
  if (email === undefined || password === undefined) {
    return null;
  }
  // Locality is the container's resolved answer, not a second opinion formed here.
  if (!isLocal) {
    return null;
  }
  const url = binding(env.SUPABASE_URL);
  if (url === undefined || !isLoopbackHttpUrl(url)) {
    return null;
  }
  return { email, password };
};

/** True when this deployment has auto sign-in configured, whatever the browser did. */
export const devAutoSignInEnabled = (container: Container): boolean =>
  devAutoSignInFor(container.env, container.isLocal) !== null;

/** Whether this browser has asked to stay signed out. */
export const devSignedOut = (cookies: Cookies): boolean =>
  cookies.get(DEV_SIGNED_OUT_COOKIE) !== undefined;

/** Record the sign-out, so the next page load does not undo it. */
export const markDevSignedOut = (cookies: Cookies): void => {
  cookies.set(DEV_SIGNED_OUT_COOKIE, '1', {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
  });
};

/** Clear the marker: the next request signs in as the seeded account again. */
export const clearDevSignedOut = (cookies: Cookies): void => {
  cookies.delete(DEV_SIGNED_OUT_COOKIE, { path: '/' });
};

/** Why auto sign-in did or did not happen, for the hook's log line. */
export type DevAutoSignInOutcome =
  | 'applied'
  | 'not-configured'
  | 'signed-out'
  | 'existing-session'
  | 'not-a-page'
  | 'failed';

/**
 * Sign this request in as the seeded account, when that is what this is.
 *
 * Called before the session is resolved, so the page that triggers it renders with
 * the session it just created rather than redirecting a second time.
 */
export const applyDevAutoSignIn = async (
  container: Container,
  cookies: Cookies,
  request: Request,
): Promise<DevAutoSignInOutcome> => {
  const account = devAutoSignInFor(container.env, container.isLocal);
  if (account === null) {
    return 'not-configured';
  }
  if (devSignedOut(cookies)) {
    return 'signed-out';
  }
  if (cookies.getAll().some(({ name }) => /^sb-.+-auth-token(?:\.\d+)?$/.test(name))) {
    return 'existing-session';
  }
  const url = new URL(request.url);
  // A page load, not a mutation: a POST must never acquire a session behind the
  // caller's back, and `/api/*` is where sign-out lives.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return 'not-a-page';
  }
  if (isApiPath(url.pathname)) {
    return 'not-a-page';
  }
  try {
    const applied = await submitAuthAction(
      container,
      request,
      cookies,
      'sign-in/email',
      account,
      null,
    );
    // Supabase Auth reported success and wrote no cookie: that is the same
    // zero-cookie outcome the sign-in action treats as a failure, and treating it
    // as success here would leave the developer staring at a sign-in form with no
    // explanation on every reload.
    return applied > 0 ? 'applied' : 'failed';
  } catch {
    return 'failed';
  }
};

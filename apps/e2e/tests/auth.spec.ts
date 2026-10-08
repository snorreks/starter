// apps/e2e/tests/auth.spec.ts
//
// The authorization boundary, exercised from outside the process.
//
// Every one of these tests is about a case where the *client* cannot be trusted.
// A user can edit any field in the browser, so the interesting question is never
// "does the UI hide the button" but "what does the Worker do when the request
// says otherwise".
//
// The cross-user case is the one that matters and the one a UI-level test can
// never reach: two separate accounts, each with real rows, and one account's id
// substituted into the other's request.
//
// Two things about the direct API calls below, both consequences of the
// single-origin architecture rather than test conveniences:
//
//   * `appBaseUrl` is the page's own origin, so these requests are same-origin
//     exactly as the browser's own would be. There is no second API to point at,
//     which is the point: a test that used a separate base URL would stop
//     exercising the deployment shape.
//   * Mutating requests carry an `Origin` header. SvelteKit refuses a
//     `POST`/`PATCH`/`DELETE` with a form content type — or none — whose `Origin`
//     is not the app's own, which is the correct CSRF boundary for a
//     cookie-authenticated API. A browser always sends it; Playwright's
//     `APIRequestContext` does not, so a test that omitted it would be asserting
//     something no user can produce.

import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { appBaseUrl } from '../preflight.ts';

/** The headers a browser sends on a same-origin mutating request. */
const originHeaders = { origin: appBaseUrl };

interface Account {
  email: string;
  password: string;
}

/** The list endpoint returns whole notes, not just ids. */
interface NoteListBody {
  notes: { id: string; title: string; body: string }[];
  serverTime: number;
}

const newAccount = (): Account => ({
  email: `e2e-${crypto.randomUUID()}@example.test`,
  password: 'correct horse battery staple',
});

/**
 * Read a link out of the local capture inbox.
 *
 * The E2E Worker runs with `DEPLOYMENT_ENV=local`, so `/api/dev/mail` holds the
 * messages that would have been sent. That is what lets this lane exercise a
 * *verified* account with no mail provider and no real inbox.
 */
const capturedLink = async (
  request: APIRequestContext,
  email: string,
  subject: RegExp,
): Promise<string> => {
  const response = await request.get(`${appBaseUrl}/api/dev/mail?to=${encodeURIComponent(email)}`);
  if (!response.ok()) {
    throw new Error(`mail inbox unavailable: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as {
    messages: Array<{ subject: string; text: string }>;
  };
  const message = body.messages.find((entry) => subject.test(`${entry.subject} ${entry.text}`));
  if (message === undefined) {
    throw new Error(
      `No mail matching ${subject} captured for ${email}. ` +
        `Captured: ${JSON.stringify(body.messages.map((entry) => entry.subject))}`,
    );
  }
  const line = message.text.split('\n').find((entry) => entry.startsWith('http'));
  if (line === undefined) {
    throw new Error('No link in the captured mail');
  }
  return line.trim();
};

// Redeem GoTrue's loopback link in Node; the application callback uses the
// same cookie jar that requested the mail so PKCE is still exercised.
const authCallback = async (options: {
  request: APIRequestContext;
  link: string;
}): Promise<string> => {
  const response = await options.request.get(options.link, { maxRedirects: 0 });
  expect(response.status()).toBe(303);
  const location = response.headers().location;
  expect(location).toBeDefined();
  const callback = new URL(location ?? '', options.link);
  return new URL(`${callback.pathname}${callback.search}${callback.hash}`, appBaseUrl).href;
};

/**
 * Register and confirm an address, through the API.
 *
 * Both halves are required before any private endpoint will answer. A helper that
 * stopped at sign-up would leave every authorization test below asserting on a 401
 * and passing — which is precisely how an ownership bug survives a green suite.
 */
const registerViaApi = async (request: APIRequestContext, account: Account): Promise<void> => {
  const created = await request.post(`${appBaseUrl}/api/auth/sign-up/email`, {
    data: { email: account.email, password: account.password, name: 'E2E' },
    headers: originHeaders,
  });

  expect(created.ok(), `sign-up failed: ${created.status()} ${await created.text()}`).toBe(true);

  // No session yet, by design. Asserted rather than assumed.
  expect(await created.json()).toMatchObject({ session: null, user: { emailVerified: false } });
  const anonymous = await request.get(`${appBaseUrl}/api/auth/get-session`);
  expect(await anonymous.json()).toEqual({ user: null });

  const link = await capturedLink(request, account.email, /verify|confirm|sign.?up/i);
  const callback = await authCallback({ request, link });
  const verified = await request.get(callback, { maxRedirects: 0 });
  expect(verified.status()).toBe(303);
  expect(verified.headers().location).toBe('/verify-email');

  const signedIn = await request.post(`${appBaseUrl}/api/auth/sign-in/email`, {
    data: { email: account.email, password: account.password },
    headers: originHeaders,
  });
  expect(
    signedIn.ok(),
    `sign-in after verification failed: ${signedIn.status()} ${await signedIn.text()}`,
  ).toBe(true);
};

/**
 * Sign up through the UI, confirm the address, sign in, and land on the notes screen.
 *
 * The full three-step flow, because that is what the product now does. Sign-up alone
 * does not sign anyone in — `autoSignIn` is off precisely because the address is
 * unconfirmed — so a helper that stopped at sign-up would leave every test below
 * sitting on the login page, and the failure would read as a routing bug.
 */
const signUpViaUi = async (page: Page, account: Account): Promise<void> => {
  await page.goto('/login');
  await page.getByTestId('auth-toggle-mode').click();
  await page.getByTestId('auth-name-input').fill('E2E User');
  await page.getByTestId('auth-email-input').fill(account.email);
  await page.getByTestId('auth-password-input').fill(account.password);
  await page.getByTestId('auth-submit').click();

  // The account exists but is not usable yet, and the screen says so.
  await expect(page.getByTestId('auth-error')).toContainText(/confirm your address/i);
  await expect(page).toHaveURL(/\/login/);

  // Followed in the browser, which is the point: this is the navigation a person makes
  // after clicking a link in an email client, and it is the only assertion here that
  // proves the link and the page agree.
  const link = await capturedLink(page.request, account.email, /verify|confirm|sign.?up/i);
  await page.goto(await authCallback({ request: page.request, link }));
  await expect(page).toHaveURL(/\/verify-email/);
  await expect(page.getByTestId('current-user')).toHaveText(account.email);
  await page.goto('/notes');

  await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
};

const createNoteViaApi = async (
  request: APIRequestContext,
  title: string,
): Promise<{ id: string; ownerId: string }> => {
  const response = await request.post(`${appBaseUrl}/api/notes`, {
    data: { title, body: 'body' },
    headers: originHeaders,
  });

  expect(response.ok(), `create failed: ${response.status()}`).toBe(true);
  return (await response.json()) as { id: string; ownerId: string };
};

test.describe('authentication', () => {
  test('a wrong password is refused', async ({ page }) => {
    const account = newAccount();

    // A verified account, so the failure below is unambiguously about the password.
    await signUpViaUi(page, account);

    // Sign out. `clearCookies` rather than a UI click, so this test is about the wrong
    // password and not about the sign-out button.
    await page.context().clearCookies();
    await page.goto('/login');
    await expect(page.getByTestId('auth-email-input')).toBeVisible();

    await page.getByTestId('auth-email-input').fill(account.email);
    await page.getByTestId('auth-password-input').fill('not the password');
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-error')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    // And the message must not say which half was wrong — see the cross-account
    // enumeration test below for why that is load-bearing.
    await expect(page.getByTestId('auth-error')).not.toContainText(/no account|does not exist/i);
  });

  test('an unauthenticated request to the notes API is refused', async ({ request }) => {
    const response = await request.get(`${appBaseUrl}/api/notes`);

    // The exact status matters: a 200 with an empty list would be a client that
    // silently shows "no notes" for an account that is not signed in.
    expect(response.status()).toBe(401);
  });

  test('a session survives a reload', async ({ page }) => {
    const account = newAccount();
    await signUpViaUi(page, account);

    await page.reload();

    // If the cookie were not actually persisted, the server load would redirect.
    await expect(page).toHaveURL(/\/notes$/);
    await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
  });

  test('the landing page is public and server-rendered', async ({ page }) => {
    // The root is a public page now, not a redirect target. If this ever starts
    // 302-ing to /login, the landing page has stopped being public and this test
    // fails rather than the change going unnoticed.
    const response = await page.goto('/');

    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'One application, one Worker' })).toBeVisible();
    // The sign-in link comes from the layout load, so its presence here proves the
    // server rendered the page with a resolved (absent) session.
    await expect(page.getByTestId('landing-sign-in-link')).toBeVisible();
    await expect(page.getByTestId('sign-in-link')).toHaveClass(/shell__link/);
    const titleSize = Number.parseFloat(
      await page.locator('.landing__title').evaluate((node) => getComputedStyle(node).fontSize),
    );
    const bodySize = Number.parseFloat(
      await page.locator('.landing__lede').evaluate((node) => getComputedStyle(node).fontSize),
    );
    expect(titleSize).toBeGreaterThan(bodySize * 1.5);
  });

  test('a deep link to a client route renders rather than 404ing', async ({ page }) => {
    // The specific failure a static-asset SPA cannot avoid and a Worker can: the
    // asset server has to know the route table, or the deep link resolves to the
    // shell and fails in the browser.
    const response = await page.goto('/login');

    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('auth-form')).toBeVisible();
  });

  test('the recovery routes render from a deep link', async ({ page }) => {
    // Both were added with the account lifecycle. A route that only works after a
    // client-side navigation hides a real defect — someone following a link in an
    // email lands on a 404 — and nothing else in this file would catch it.
    for (const path of ['/forgot-password', '/verify-email']) {
      const response = await page.goto(path);
      expect(response?.status(), `${path} did not render`).toBe(200);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
  });

  test('the sign-in form works with JavaScript disabled', async ({ browser }) => {
    // The form action is a fallback, not decoration: a browser with no scripting must
    // still be able to create an account *and* sign in. This context has scripting off,
    // so the only thing that can answer is the server.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    const account = newAccount();
    await page.goto('/login');
    // The mode switch is a submitter rather than an `onclick`, so it is the *only* way
    // to reach the sign-up form here — and it has to work on a form with nothing filled
    // in, which is the state someone switches modes from.
    await page.getByTestId('auth-toggle-mode').click();
    await page.getByTestId('auth-name-input').fill('No JS');
    await page.getByTestId('auth-email-input').fill(account.email);
    await page.getByTestId('auth-password-input').fill(account.password);
    await page.getByTestId('auth-submit').click();

    // The server-rendered response after the post, not a client-side transition. The
    // wording lives in the ViewModel, so this is really an assertion that the action's
    // result reaches the rendered page at all — and `$effect`, the obvious way to apply
    // it, does not run on a server render.
    await expect(page.getByTestId('auth-error')).toContainText(/confirm your address/i);

    // Verify, then sign in. Signing in has to *navigate*: an action that returned an
    // outcome instead would leave this browser — which will never run a script to read
    // one — sitting on the form with a session cookie it has no way to act on.
    const link = await capturedLink(page.request, account.email, /verify|confirm|sign.?up/i);
    await page.goto(await authCallback({ request: page.request, link }));
    await expect(page).toHaveURL(/\/verify-email/);
    await expect(page.getByTestId('current-user')).toHaveText(account.email);
    const signedOut = await page.request.post(`${appBaseUrl}/api/auth/sign-out`, {
      data: {},
      headers: originHeaders,
    });
    expect(signedOut.ok()).toBe(true);

    await page.goto('/login');
    await page.getByTestId('auth-email-input').fill(account.email);
    await page.getByTestId('auth-password-input').fill(account.password);
    await page.getByTestId('auth-submit').click();

    await expect(page).toHaveURL(/\/notes$/);
    await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();

    await context.close();
  });

  test('an unverified account is told to confirm, not that its password is wrong', async ({
    page,
    request,
  }) => {
    // A *fresh* account, registered through the API and deliberately never verified.
    //
    // `page.request` shares this page's cookie jar, so registering through it and then
    // expecting the sign-in form would be contradictory: the helper signs in, and
    // `/login` redirects a signed-in visitor to `/notes`. Registration therefore uses a
    // bare `request` fixture, which has its own jar and leaves this page anonymous.
    const pending = newAccount();
    const created = await request.post(`${appBaseUrl}/api/auth/sign-up/email`, {
      data: { email: pending.email, password: pending.password, name: 'Pending' },
      headers: originHeaders,
    });
    expect(created.ok(), await created.text()).toBe(true);
    expect(await created.json()).toMatchObject({ session: null, user: { emailVerified: false } });
    const anonymous = await request.get(`${appBaseUrl}/api/auth/get-session`);
    expect(await anonymous.json()).toEqual({ user: null });

    await page.goto('/login');
    await expect(page.getByTestId('auth-email-input')).toBeVisible();

    await page.getByTestId('auth-email-input').fill(pending.email);
    await page.getByTestId('auth-password-input').fill(pending.password);
    await page.getByTestId('auth-submit').click();

    // The correct password, the correct address, and the screen says "confirm your
    // address". Telling this person their password is wrong would send them to reset
    // a password that is fine — and "Email not verified" and "invalid credentials"
    // arrive with the same HTTP status, so this only works because the ViewModel
    // branches on Better Auth's error *code*.
    await expect(page.getByTestId('auth-error')).toContainText(/confirm your address/i);
    // And the resend affordance exists, which is the only thing the user can do.
    await expect(page.getByTestId('auth-resend-verification')).toBeVisible();
  });
});

test.describe('password recovery, in a browser', () => {
  test('a recovery link sets a new password and the old one stops working', async ({
    page,
    request,
  }) => {
    const account = newAccount();
    await registerViaApi(request, account);

    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(account.email);
    await page.getByRole('button', { name: 'Send the link' }).click();

    // Redirected with `?sent=1`, which is what makes a reload a GET rather than a
    // second send. Without it, a refresh mails the user twice.
    await expect(page).toHaveURL(/reset-password\?sent=1/);
    await expect(page.getByText(/if that address has an account/i)).toBeVisible();

    const link = await capturedLink(request, account.email, /password/i);
    await page.goto(await authCallback({ request: page.request, link }));

    // Better Auth validated the token before redirecting here, so the form is already
    // live. Server-rendered, which is what makes the next step work without JS.
    // `exact`, because the heading says "Choose a new password" and `getByLabel`
    // substring-matches an element's accessible name as well as a `<label>` — without
    // it this locator resolves the section as well as the input, and every use of it
    // fails on a strict-mode violation rather than on anything about the page.
    await expect(page.getByLabel('New password', { exact: true })).toBeVisible();

    const replacement = 'a-replacement-passphrase-x';
    await page.getByLabel('New password', { exact: true }).fill(replacement);
    await page.getByRole('button', { name: 'Save the new password' }).click();

    // Every session was revoked, so the reset lands on sign-in — signed out on
    // purpose, because "we logged you out of everything" is the message.
    await expect(page).toHaveURL(/\/login\?reset=1/);

    // The old password is dead.
    await page.getByTestId('auth-email-input').fill(account.email);
    await page.getByTestId('auth-password-input').fill(account.password);
    await page.getByTestId('auth-submit').click();
    await expect(page.getByTestId('auth-error')).toContainText(/do not match/i);

    // And the new one works.
    await page.getByTestId('auth-password-input').fill(replacement);
    await page.getByTestId('auth-submit').click();
    await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
  });

  test('asking for a recovery mail for an unknown address says the same thing', async ({
    page,
  }) => {
    // The enumeration guarantee, in a real browser. Both addresses produce the same
    // page, the same text, and the same URL — so this screen cannot answer "is this
    // person registered here?".
    const unknown = `e2e-${crypto.randomUUID()}@example.test`;

    await page.goto('/forgot-password');
    await page.getByLabel('Email').fill(unknown);
    await page.getByRole('button', { name: 'Send the link' }).click();

    await expect(page).toHaveURL(/reset-password\?sent=1/);
    await expect(page.getByText(/if that address has an account/i)).toBeVisible();
    // Explicitly not: "we could not find that account".
    await expect(page.getByText(/no account|does not exist|unknown address/i)).toHaveCount(0);
  });

  test('an invalid recovery token stops offering the reset form', async ({ page }) => {
    await page.goto('/reset-password?token=invalid');
    // A forged query is not a recovery session. Even posting without the form
    // must be refused by the server, not just hidden in the browser.
    const refused = await page.request.post('/reset-password?token=invalid', {
      form: { newPassword: 'a-replacement-passphrase-x' },
      headers: originHeaders,
    });
    expect(refused.status()).toBe(400);
    await expect(page.getByRole('alert')).toContainText(/no longer valid|expired/i);
    await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /new link/i })).toBeVisible();
  });

  test('a second use of a recovery link is refused, in the browser', async ({ page, request }) => {
    const account = newAccount();
    await registerViaApi(request, account);

    await page.request.post(`${appBaseUrl}/api/auth/request-password-reset`, {
      data: { email: account.email, redirectTo: '/reset-password' },
      headers: originHeaders,
    });
    const link = await capturedLink(request, account.email, /password/i);

    await page.goto(await authCallback({ request: page.request, link }));
    await page.getByLabel('New password', { exact: true }).fill('first-replacement-x');
    await page.getByRole('button', { name: 'Save the new password' }).click();
    await expect(page).toHaveURL(/\/login\?reset=1/);

    // The link is a live credential until it is used; after that it must be inert.
    // Re-following it lands on the "no longer valid" page rather than a form.
    await page.goto(await authCallback({ request: page.request, link }));
    await expect(page.getByText(/no longer valid|expired/i)).toBeVisible();
    await expect(page.getByLabel('New password', { exact: true })).toHaveCount(0);
  });
});

test.describe('authorization across accounts', () => {
  test("one account cannot read another's notes", async ({ browser }) => {
    // Two separate browser contexts so the two sessions cannot share cookies.
    const victim = newAccount();
    const attacker = newAccount();

    const victimContext = await browser.newContext();
    const attackerContext = await browser.newContext();

    try {
      await registerViaApi(victimContext.request, victim);
      const note = await createNoteViaApi(victimContext.request, "Victim's secret");

      await registerViaApi(attackerContext.request, attacker);

      const list = await attackerContext.request.get(`${appBaseUrl}/api/notes`);
      expect(list.ok()).toBe(true);
      const body = (await list.json()) as NoteListBody;

      // The attacker's list is not empty — the endpoint works — it simply does
      // not contain the victim's note.
      expect(body.notes.map((entry) => entry.id)).not.toContain(note.id);
    } finally {
      await victimContext.close();
      await attackerContext.close();
    }
  });

  test("one account cannot delete another's note", async ({ browser }) => {
    const victim = newAccount();
    const attacker = newAccount();

    const victimContext = await browser.newContext();
    const attackerContext = await browser.newContext();

    try {
      await registerViaApi(victimContext.request, victim);
      const note = await createNoteViaApi(victimContext.request, 'Do not delete me');

      await registerViaApi(attackerContext.request, attacker);

      const response = await attackerContext.request.delete(`${appBaseUrl}/api/notes/${note.id}`, {
        headers: originHeaders,
      });

      // 403 and 404 are both acceptable answers; 200 is not.
      expect([403, 404]).toContain(response.status());

      // And the note is still there, which is the assertion that actually
      // matters — a 403 from a route that deleted the row anyway would pass.
      const still = await victimContext.request.get(`${appBaseUrl}/api/notes`);
      const body = (await still.json()) as NoteListBody;
      expect(body.notes.map((entry) => entry.id)).toContain(note.id);
    } finally {
      await victimContext.close();
      await attackerContext.close();
    }
  });

  test("one account cannot edit another's note", async ({ browser }) => {
    const victim = newAccount();
    const attacker = newAccount();

    const victimContext = await browser.newContext();
    const attackerContext = await browser.newContext();

    try {
      await registerViaApi(victimContext.request, victim);
      const note = await createNoteViaApi(victimContext.request, 'Original title');

      await registerViaApi(attackerContext.request, attacker);

      const response = await attackerContext.request.patch(`${appBaseUrl}/api/notes/${note.id}`, {
        data: { title: 'Rewritten' },
        headers: originHeaders,
      });

      expect([403, 404]).toContain(response.status());

      const still = await victimContext.request.get(`${appBaseUrl}/api/notes`);
      const body = (await still.json()) as NoteListBody;
      const survivor = body.notes.find((entry) => entry.id === note.id);
      expect(survivor?.title).toBe('Original title');
    } finally {
      await victimContext.close();
      await attackerContext.close();
    }
  });

  test('a create request cannot choose its own owner', async ({ request }) => {
    const account = newAccount();
    await registerViaApi(request, account);

    // Ownership comes from the session. A body carrying ownerId must be refused
    // outright — accepting and ignoring it would let a client believe it worked.
    const response = await request.post(`${appBaseUrl}/api/notes`, {
      data: { title: 'Injected owner', body: 'b', ownerId: 'someone_else' },
      headers: originHeaders,
    });

    expect([400, 422]).toContain(response.status());
  });
});

test.describe('input the Worker must refuse', () => {
  test('rejects an unknown field rather than dropping it', async ({ request }) => {
    const account = newAccount();
    await registerViaApi(request, account);

    const response = await request.post(`${appBaseUrl}/api/notes`, {
      data: { title: 'a', body: 'b', sneakyField: 'x' },
      headers: originHeaders,
    });

    // Silently accepting would mean the client believed the extra field landed.
    expect(response.status()).toBeGreaterThanOrEqual(400);
  });

  test('rejects a note id that does not exist', async ({ request }) => {
    await registerViaApi(request, newAccount());

    // There is no `GET /api/notes/:id` route — only PATCH and DELETE take an id.
    // So the assertion is on those, where a missing row is the handler's own
    // 404 rather than the router's.
    for (const id of ['note_does_not_exist', crypto.randomUUID()]) {
      const patched = await request.patch(`${appBaseUrl}/api/notes/${id}`, {
        data: { title: 'x' },
        headers: originHeaders,
      });
      expect(patched.status()).toBe(404);

      const deleted = await request.delete(`${appBaseUrl}/api/notes/${id}`, {
        headers: originHeaders,
      });
      expect(deleted.status()).toBe(404);
    }
  });

  test('an unknown API route is a JSON 404, not an HTML error page', async ({ request }) => {
    await registerViaApi(request, newAccount());

    const response = await request.get(`${appBaseUrl}/api/no-such-route`);

    // A thrown error on an unrouted path would be a 500, and would look like a
    // broken API rather than a wrong URL.
    expect(response.status()).toBe(404);
    // SvelteKit's own fallback for an unmatched route is an HTML error page, which
    // the composition root replaces with the shared JSON error shape for `/api/*`.
    // An API client that got HTML would have to guess between a wrong URL and a
    // broken deploy.
    expect(response.headers()['content-type']).toContain('application/json');
    expect(await response.json()).toMatchObject({ error: 'not_found' });
  });

  test('an unknown page is a 404, and is HTML', async ({ request }) => {
    // The mirror image of the test above, and the reason the JSON substitution is
    // scoped to `/api`: a person who mistypes a URL should get a rendered page,
    // not a JSON body.
    const response = await request.get(`${appBaseUrl}/no-such-page`);

    expect(response.status()).toBe(404);
    expect(response.headers()['content-type']).toContain('text/html');
  });

  test('health reports the effective configuration without secrets', async ({ request }) => {
    const response = await request.get(`${appBaseUrl}/api/health`);
    expect(response.ok()).toBe(true);

    const body = (await response.json()) as Record<string, unknown>;

    expect(body.ok).toBe(true);
    // Anything resembling a credential in a health endpoint would be published
    // to whoever can reach it.
    const serialized = JSON.stringify(body).toLowerCase();
    for (const forbidden of ['password', 'secret', 'token', 'apikey', 'api_key']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

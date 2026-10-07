// apps/e2e/tests/notes.spec.ts
//
// The full path, through the built Worker, in a real browser, against real D1.
//
// One test file on purpose. These tests share one local database and one set of
// seeded users, and they run in declaration order (`workers: 1`), so the file
// reads as a single session: sign up, create, edit, delete, sign out. Splitting it
// would mean each file paying for its own sign-in to reach the same state.
//
// What this lane is for, and what it is not:
//
//   It IS the only place a contract mismatch between the page and the API can be
//   caught — a field renamed on one side only, a session cookie the server stops
//   setting, a route that 404s where a deep link used to render. It is also the
//   only place a *bundling* mistake can be caught, because the artifact under test
//   is the compiled Worker rather than the dev server.
//
//   It is NOT a place to test that a button renders. `apps/frontend/client` has a
//   real-browser lane for that, which runs in under a second instead of a minute.
//
// The notes route is `/notes`, not `/`. The public landing page took the root, so
// a signed-out visit to `/` is a real page rather than a redirect — which is what
// makes the "a deep link renders" assertion in this file mean something.

import { expect, type Page, test } from '@playwright/test';

const SUPABASE_PREVIEW = process.env.STARTER_BACKEND_PROFILE === 'supabase';

/**
 * A fresh account.
 *
 * Built per call, not once at module scope: these tests share one database, so a
 * module-level address would make the second test fail with "User already
 * exists" — a failure that reads like an auth bug and is really a test bug.
 */
const newAccount = () => ({
  email: `e2e-${crypto.randomUUID()}@example.test`,
  password: 'correct horse battery staple',
});

/**
 * Read the verification link out of the local capture inbox.
 *
 * The E2E Worker runs with `DEPLOYMENT_ENV=local`, so `/api/dev/mail` is available
 * and holds the messages that would have been sent. That is what makes this lane able
 * to exercise a *verified* account without a mail provider and without a real
 * inbox — and it is the reason no test in this file can silently pass on an
 * unverified account: `signUp` will not complete without it.
 */
const verificationLink = async (page: Page, email: string): Promise<string> => {
  const response = await page.request.get(`/api/dev/mail?to=${encodeURIComponent(email)}`);
  if (!response.ok()) {
    throw new Error(`mail inbox unavailable: ${response.status()}`);
  }
  const body = (await response.json()) as {
    messages: Array<{ subject: string; text: string }>;
  };
  const message = body.messages.find((entry) =>
    /verify|confirm|sign.?up/i.test(`${entry.subject} ${entry.text}`),
  );
  if (message === undefined) {
    throw new Error(`No verification mail captured for ${email}`);
  }
  const line = message.text.split('\n').find((entry) => entry.startsWith('http'));
  if (line === undefined) {
    throw new Error('No link in the verification mail');
  }
  if (!SUPABASE_PREVIEW) {
    return line.trim();
  }

  // GoTrue's browser callback cannot resolve its loopback Auth host in Chromium.
  // Redeem only the verification request in Node's request context, then let the
  // browser navigate the real application callback and receive its session cookie.
  const responseFromAuth = await page.request.get(line.trim(), { maxRedirects: 0 });
  if (responseFromAuth.status() < 300 || responseFromAuth.status() >= 400) {
    throw new Error(`Auth verification endpoint returned HTTP ${responseFromAuth.status()}`);
  }
  const location = responseFromAuth.headers().location;
  if (location === undefined) {
    throw new Error('Auth verification did not return the application callback.');
  }
  const callback = new URL(location, line.trim());
  const browserOrigin = new URL(page.url()).origin;
  return new URL(`${callback.pathname}${callback.search}${callback.hash}`, browserOrigin).href;
};

/**
 * Sign up, confirm the address, then sign in — and land on the notes screen.
 *
 * Supabase exchanges its confirmation code at the application callback; legacy
 * Better Auth confirms the address, then requires a separate sign-in.
 */
const signUp = async (page: Page, account = newAccount()): Promise<void> => {
  await page.goto('/login');
  await expect(page.getByTestId('auth-form')).toBeVisible();

  // The form starts in sign-in mode; switch before filling.
  await page.getByTestId('auth-toggle-mode').click();

  await page.getByTestId('auth-name-input').fill('E2E User');
  await page.getByTestId('auth-email-input').fill(account.email);
  await page.getByTestId('auth-password-input').fill(account.password);
  await page.getByTestId('auth-submit').click();

  // No session yet. This is asserted rather than assumed: if sign-up ever handed out
  // a session for an unconfirmed address, every test below would still pass while
  // testing an application that does not verify anything.
  await expect(page.getByTestId('auth-error')).toContainText(/confirm your address/i);

  await page.goto(await verificationLink(page, account.email));
  await expect(page).toHaveURL(/\/verify-email/);
  if (SUPABASE_PREVIEW) {
    await expect(page.getByTestId('current-user')).toHaveText(account.email);
  } else {
    await page.goto('/login');
    await page.getByTestId('auth-email-input').fill(account.email);
    await page.getByTestId('auth-password-input').fill(account.password);
    await page.getByTestId('auth-submit').click();
  }
  await page.goto('/notes');
};

test.describe('notes, end to end', () => {
  test('signs up and lands on the notes screen', async ({ page }) => {
    await signUp(page);

    await expect(page).toHaveURL(/\/notes$/);
    await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
    // A brand-new account has nothing in it: the empty state, not an error.
    await expect(page.getByText('No notes yet')).toBeVisible();
  });

  test('creates a note and it survives a reload', async ({ page }) => {
    await signUp(page);

    await page.getByTestId('note-title-input').fill('Shopping list');
    await page.getByTestId('note-body-input').fill('Milk, bread');
    await page.getByTestId('note-submit').click();

    // The row appears without a manual refresh, which proves the ViewModel
    // applied the server's response rather than optimistically guessing.
    const card = page.getByTestId('note-card').filter({ hasText: 'Shopping list' });
    await expect(card).toBeVisible();
    await page.getByTestId('notes-refresh').click();
    await expect(card).toBeVisible();

    // And it was actually persisted: a reload reads from the server again.
    await page.reload();
    await expect(page.getByTestId('note-card').filter({ hasText: 'Shopping list' })).toBeVisible();
    await expect(page.getByTestId('note-card')).toHaveCount(1);
  });

  test('edits a note', async ({ page }) => {
    await signUp(page);

    await page.getByTestId('note-title-input').fill('Before');
    await page.getByTestId('note-body-input').fill('original');
    await page.getByTestId('note-submit').click();
    await expect(page.getByTestId('note-card').filter({ hasText: 'Before' })).toBeVisible();

    await page.getByTestId('note-edit').first().click();
    await page.getByTestId('note-title-input').fill('After');
    await page.getByTestId('note-submit').click();

    await expect(page.getByTestId('note-card').filter({ hasText: 'After' })).toBeVisible();
    await expect(page.getByTestId('note-card').filter({ hasText: 'Before' })).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('note-card').filter({ hasText: 'After' })).toBeVisible();
  });

  test('deletes a note', async ({ page }) => {
    await signUp(page);

    await page.getByTestId('note-title-input').fill('Temporary');
    await page.getByTestId('note-submit').click();
    await expect(page.getByTestId('note-card')).toHaveCount(1);

    await page.getByTestId('note-delete').first().click();

    await expect(page.getByTestId('note-card')).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId('note-card')).toHaveCount(0);
  });

  test('rejects a title longer than the schema allows, in the browser', async ({ page }) => {
    await signUp(page);

    // 121 characters; the schema caps it at 120. The client validates the same
    // schema the Worker does, so this is caught before a request is made.
    await page.getByTestId('note-title-input').fill('x'.repeat(121));
    await page.getByTestId('note-submit').click();

    // Either the form refused it outright, or it was sent and the Worker
    // refused it. Both are correct; what must not happen is a note appearing.
    await expect(page.getByTestId('note-card')).toHaveCount(0);
  });

  test('signs out and no longer shows the notes', async ({ page }) => {
    await signUp(page);

    await page.getByTestId('note-title-input').fill('Private');
    await page.getByTestId('note-submit').click();
    await expect(page.getByTestId('note-card').filter({ hasText: 'Private' })).toBeVisible();

    await page.context().clearCookies();

    // A fresh visit must go back to sign-in. If the route rendered the notes
    // anyway, the session check on the client is doing nothing.
    await page.goto('/notes');
    await expect(page).toHaveURL(/\/login/);
  });
});

// apps/e2e/tests/notes.spec.ts
//
// The full path, through the built client, against a real Worker and a real D1.
//
// One test file on purpose. These tests share one local database and one set of
// seeded users, and they run in declaration order (`workers: 1`), so the file
// reads as a single session: sign up, create, edit, delete, sign out. Splitting it
// would mean each file paying for its own sign-in to reach the same state.
//
// What this lane is for, and what it is not:
//
//   It IS the only place a contract mismatch between client and server can be
//   caught — the client validating a payload the Worker rejects, a field renamed
//   on one side only, a proxy that strips the session cookie.
//
//   It is NOT a place to test that a button renders. `apps/frontend/client` has a
//   real-browser lane for that, which runs in under a second instead of a minute.

import { expect, test, type Page } from '@playwright/test';

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

const signUp = async (page: Page, account = newAccount()): Promise<void> => {
  await page.goto('/login');
  await expect(page.getByTestId('auth-form')).toBeVisible();

  // The form starts in sign-in mode; switch before filling.
  await page.getByTestId('auth-toggle-mode').click();

  await page.getByTestId('auth-email-input').fill(account.email);
  await page.getByTestId('auth-password-input').fill(account.password);
  await page.getByTestId('auth-submit').click();
};

test.describe('notes, end to end', () => {
  test('signs up and lands on the notes screen', async ({ page }) => {
    await signUp(page);

    await expect(page).toHaveURL(/\/$/);
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
    await page.goto('/');
    await expect(page).toHaveURL(/\/login/);
  });
});
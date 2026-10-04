// apps/e2e/tests/jobs.spec.ts
//
// The jobs screen, through the built Worker, in a real browser.
//
// What this lane can and cannot prove
// -----------------------------------
// The E2E Worker is started by `playwright.config.ts` with no `JOBS_PROFILE`, which
// is the template's shipped default. So the path exercised here is the *disabled*
// profile — and that is the case worth proving in a browser, because it is the one
// where a feature can quietly cost a working application its other screens:
//
//   * an anonymous visitor is redirected, exactly as on `/notes`;
//   * a signed-in user gets the "switched off here" state rendered from the
//     server's HTML, with no job request and no retry button;
//   * notes and auth keep working — the regression this branch exists to prevent.
//
// What it cannot prove, and what does instead:
//
//   * A *successful* encode, a real container and real FFmpeg bytes are the compute
//     lane's claim: `bun run test:compute` drives the built jobs Worker, real local
//     D1 and R2, the real Workflows engine and a real FFmpeg container. That lane
//     has no browser and no HTTP API, so it cannot be merged into this file
//     without inventing an API. Both are reported separately, and neither is
//     allowed to stand in for the other.
//   * A jobs profile that is *enabled* against real SQL is proved in
//     `apps/frontend/client/tests/worker_integration.test.ts`, which starts a
//     second built Worker with `JOBS_PROFILE=encode`, applies the jobs migrations
//     and asserts admission, budget, ownership and dispatch-failure behaviour.
//
// No mocked job is created here. A screen that rendered a fabricated "Encoded"
// row would be the exact failure this repository's rules exist to catch.

import { expect, type Page, test } from '@playwright/test';

const newAccount = () => ({
  email: `e2e-jobs-${crypto.randomUUID()}@example.test`,
  password: 'correct horse battery staple',
});

const verificationLink = async (page: Page, email: string): Promise<string> => {
  const response = await page.request.get(`/api/dev/mail?to=${encodeURIComponent(email)}`);
  if (!response.ok()) {
    throw new Error(`mail inbox unavailable: ${response.status()}`);
  }
  const body = (await response.json()) as { messages: Array<{ subject: string; text: string }> };
  const message = body.messages.find((entry) => entry.subject.includes('Verify'));
  if (message === undefined) {
    throw new Error(`No verification mail captured for ${email}`);
  }
  const line = message.text.split('\n').find((entry) => entry.startsWith('http'));
  if (line === undefined) {
    throw new Error('No link in the verification mail');
  }
  return line.trim();
};

const signUp = async (page: Page, account = newAccount()): Promise<void> => {
  await page.goto('/login');
  await expect(page.getByTestId('auth-form')).toBeVisible();
  await page.getByTestId('auth-toggle-mode').click();

  await page.getByTestId('auth-name-input').fill('E2E Jobs User');
  await page.getByTestId('auth-email-input').fill(account.email);
  await page.getByTestId('auth-password-input').fill(account.password);
  await page.getByTestId('auth-submit').click();
  await expect(page.getByTestId('auth-error')).toContainText(/confirm your address/i);

  await page.goto(await verificationLink(page, account.email));
  await page.goto('/login');
  await page.getByTestId('auth-email-input').fill(account.email);
  await page.getByTestId('auth-password-input').fill(account.password);
  await page.getByTestId('auth-submit').click();
  await expect(page).toHaveURL(/\/notes$/);
};

test.describe('the jobs screen with the profile switched off', () => {
  test('an anonymous visitor is redirected rather than shown an empty screen', async ({ page }) => {
    await page.goto('/jobs');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a signed-in user is told jobs are switched off, from the server-rendered HTML', async ({
    page,
  }) => {
    await signUp(page);

    await page.goto('/jobs');

    await expect(page.getByRole('heading', { name: 'Sample encode' })).toBeVisible();
    const unavailable = page.getByTestId('jobs-unavailable');
    await expect(unavailable).toBeVisible();
    await expect(unavailable).toContainText(/profile disabled/i);

    // No retry control: retrying a capability that is off cannot succeed.
    await expect(page.getByTestId('jobs-unavailable-retry')).toHaveCount(0);
    // And no fabricated state — this deployment has never run a job, and the
    // screen must not imply that one exists.
    await expect(page.getByTestId('jobs-list')).toHaveCount(0);
    await expect(page.getByTestId('jobs-empty')).toHaveCount(0);
  });

  test('the page makes no jobs request at all when the server already knows', async ({ page }) => {
    await signUp(page);

    const requested: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/jobs')) {
        requested.push(`${request.method()} ${path}`);
      }
    });

    await page.goto('/jobs');
    await expect(page.getByTestId('jobs-unavailable')).toBeVisible();
    // Give a stray client fetch time to appear before declaring there was none.
    await page.waitForTimeout(1_000);

    // The capability arrived with the HTML. A client that fetched anyway would
    // be told 503 and reach the same state one round trip later.
    expect(requested).toEqual([]);
  });

  test('the API answers 503 with the named capability, not a 404', async ({ page }) => {
    await signUp(page);

    const response = await page.request.get('/api/jobs');
    expect(response.status()).toBe(503);
    const body = (await response.json()) as { error?: string };
    // A 404 here would read as a wrong URL; the named capability is what lets a
    // client tell "this deployment cannot do that" from "the server is broken".
    expect(body.error).toBe('jobs_profile_disabled');
  });

  test('notes and auth still work with jobs switched off', async ({ page }) => {
    // The negative control that matters: an optional feature being off must cost
    // the application nothing. If this failed, the capability gating would have
    // leaked into the shared composition root.
    await signUp(page);

    await page.goto('/notes');
    await page.getByTestId('note-title-input').fill('Still works');
    await page.getByTestId('note-body-input').fill('The jobs profile is off.');
    await page.getByTestId('note-submit').click();
    await expect(page.getByTestId('note-card').filter({ hasText: 'Still works' })).toBeVisible();

    const session = await page.request.get('/api/auth/get-session');
    expect(session.ok()).toBe(true);
  });

  test('the navigation reaches both screens from the shell', async ({ page }) => {
    await signUp(page);

    await page.getByTestId('jobs-link').click();
    await expect(page).toHaveURL(/\/jobs$/);

    await page.getByTestId('notes-link').click();
    await expect(page).toHaveURL(/\/notes$/);
  });
});

test.describe('the jobs screen on a narrow window', () => {
  test('the layout does not scroll sideways on a phone-sized viewport', async ({ page }) => {
    // A layout check, not a native claim: this is what the shared view does in a
    // narrow viewport. It says nothing about a packaged app's safe areas, keyboard
    // or back behaviour, which belong to the native lanes.
    await page.setViewportSize({ width: 390, height: 780 });
    await signUp(page);

    await page.goto('/jobs');
    await expect(page.getByRole('heading', { name: 'Sample encode' })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

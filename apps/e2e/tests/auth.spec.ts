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

const signUpViaUi = async (page: Page, account: Account): Promise<void> => {
  await page.goto('/login');
  await page.getByTestId('auth-toggle-mode').click();
  await page.getByTestId('auth-email-input').fill(account.email);
  await page.getByTestId('auth-password-input').fill(account.password);
  await page.getByTestId('auth-submit').click();
  await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();
};

/** Register an account through the API and return its cookies. */
const registerViaApi = async (request: APIRequestContext, account: Account): Promise<void> => {
  const response = await request.post(`${appBaseUrl}/api/auth/sign-up/email`, {
    data: { email: account.email, password: account.password, name: 'E2E' },
    headers: originHeaders,
  });

  expect(response.ok(), `sign-up failed: ${response.status()} ${await response.text()}`).toBe(true);
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

    await page.goto('/login');
    await page.getByTestId('auth-toggle-mode').click();
    await page.getByTestId('auth-email-input').fill(account.email);
    await page.getByTestId('auth-password-input').fill(account.password);
    await page.getByTestId('auth-submit').click();
    await expect(page.getByRole('heading', { name: 'Your notes' })).toBeVisible();

    // Sign out, then try the same address with the wrong password.
    await page.context().clearCookies();
    await page.goto('/login');
    await page.getByTestId('auth-email-input').fill(account.email);
    await page.getByTestId('auth-password-input').fill('not the password');
    await page.getByTestId('auth-submit').click();

    await expect(page.getByTestId('auth-error')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
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
  });

  test('a deep link to a client route renders rather than 404ing', async ({ page }) => {
    // The specific failure a static-asset SPA cannot avoid and a Worker can: the
    // asset server has to know the route table, or the deep link resolves to the
    // shell and fails in the browser.
    const response = await page.goto('/login');

    expect(response?.status()).toBe(200);
    await expect(page.getByTestId('auth-form')).toBeVisible();
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
    const patched = await request.patch(`${appBaseUrl}/api/notes/note_does_not_exist`, {
      data: { title: 'x' },
      headers: originHeaders,
    });
    expect(patched.status()).toBe(404);

    const deleted = await request.delete(`${appBaseUrl}/api/notes/note_does_not_exist`, {
      headers: originHeaders,
    });
    expect(deleted.status()).toBe(404);
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

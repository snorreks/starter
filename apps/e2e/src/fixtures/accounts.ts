import { expect, type Page } from '@playwright/test';
import { UI_SCENARIOS } from '@starter/fixtures';
import { appBaseUrl } from '../../preflight.ts';

const PASSWORD = 'correct horse battery staple';
const ORIGIN = { origin: appBaseUrl };

const capturedLink = async (page: Page, email: string, subject: RegExp): Promise<string> => {
  const response = await page.request.get(
    `${appBaseUrl}/api/dev/mail?to=${encodeURIComponent(email)}`,
  );
  if (!response.ok()) {
    throw new Error(`Local mail capture failed: ${response.status()} ${await response.text()}`);
  }
  const body = (await response.json()) as {
    messages: Array<{ subject: string; text: string }>;
  };
  const message = body.messages.find((item) => subject.test(`${item.subject} ${item.text}`));
  const link = message?.text.split('\n').find((line) => line.startsWith('http'));
  if (link === undefined) {
    throw new Error(`No ${subject} message with a link was captured for ${email}.`);
  }
  return link.trim();
};

/** Create and verify a real local account, then authenticate through the browser UI. */
export const createVerifiedAccount = async (page: Page): Promise<{ email: string }> => {
  const email = `visual-${crypto.randomUUID()}@example.test`;
  const created = await page.request.post(`${appBaseUrl}/api/auth/sign-up/email`, {
    data: { email, password: PASSWORD, name: 'Visual Reviewer' },
    headers: ORIGIN,
  });
  if (!created.ok()) {
    throw new Error(`Sign-up failed: ${created.status()} ${await created.text()}`);
  }
  expect(await created.json()).toMatchObject({ session: null, user: { emailVerified: false } });
  const anonymous = await page.request.get(`${appBaseUrl}/api/auth/get-session`);
  expect(await anonymous.json()).toEqual({ user: null });

  const link = await capturedLink(page, email, /verify|confirm|sign.?up/i);
  const redemption = await page.request.get(link, { maxRedirects: 0 });
  expect(redemption.status()).toBe(303);
  const location = redemption.headers().location;
  expect(location).toBeDefined();
  const callback = new URL(location ?? '', link);
  await page.goto(
    new URL(`${callback.pathname}${callback.search}${callback.hash}`, appBaseUrl).href,
  );
  await expect(page).toHaveURL(/\/verify-email/);
  await expect(page.getByTestId('current-user')).toHaveText(email);
  const verified = await page.request.get(`${appBaseUrl}/api/auth/get-session`);
  expect(await verified.json()).toMatchObject({ user: { email, emailVerified: true } });
  const logout = await page.request.post(`${appBaseUrl}/api/auth/sign-out`, {
    data: {},
    headers: ORIGIN,
  });
  expect(logout.ok()).toBe(true);
  await page.goto('/login');
  await page.getByTestId('auth-email-input').fill(email);
  await page.getByTestId('auth-password-input').fill(PASSWORD);
  await page.getByTestId('auth-submit').click();
  await page.waitForURL('**/notes');
  return { email };
};

const createNote = async (page: Page, note: { title: string; body: string }): Promise<void> => {
  const response = await page.request.post(`${appBaseUrl}/api/notes`, {
    data: note,
    headers: ORIGIN,
  });
  if (!response.ok()) {
    throw new Error(`Could not seed note: ${response.status()} ${await response.text()}`);
  }
};

/** Populate an authenticated account through the public APIs with shared data. */
export const prepareScenarioContent = async (
  page: Page,
  setup: string,
): Promise<string | undefined> => {
  if (setup === 'verified-empty-account' || setup === 'verified-account') {
    await createVerifiedAccount(page);
    return;
  }
  if (setup === 'verified-populated-account' || setup === 'verified-long-account') {
    await createVerifiedAccount(page);
    const notes =
      setup === 'verified-long-account' ? UI_SCENARIOS.notes.long : UI_SCENARIOS.notes.populated;
    for (const note of notes) {
      await createNote(page, note);
    }
    return;
  }
  if (setup === 'verified-conversation') {
    await createVerifiedAccount(page);
    const created = await page.request.post(`${appBaseUrl}/api/chat/conversations`, {
      data: { title: UI_SCENARIOS.chat.conversationTitle },
      headers: ORIGIN,
    });
    if (created.status() !== 201) {
      throw new Error(`Could not create chat fixture: ${created.status()} ${await created.text()}`);
    }
    const conversation = (await created.json()) as { id?: unknown };
    if (typeof conversation.id !== 'string' || conversation.id.length === 0) {
      throw new Error('Chat fixture response omitted its conversation id.');
    }
    const turn = await page.request.post(
      `${appBaseUrl}/api/chat/conversations/${encodeURIComponent(conversation.id)}/messages`,
      {
        data: {
          content: UI_SCENARIOS.chat.prompt,
          clientId: `visual-${crypto.randomUUID()}`,
        },
        headers: ORIGIN,
      },
    );
    const stream = await turn.text();
    if (!turn.ok() || !stream.includes('event: complete')) {
      throw new Error(`Could not seed chat turn: ${turn.status()} ${stream.slice(0, 500)}`);
    }
    return `/chat/${encodeURIComponent(conversation.id)}`;
  }
  if (setup === 'invalid-credentials') {
    await page.goto('/login');
    await page.getByTestId('auth-email-input').fill(`missing-${crypto.randomUUID()}@example.test`);
    await page.getByTestId('auth-password-input').fill('incorrect password');
    await page.getByTestId('auth-submit').click();
    await page.getByTestId('auth-error').waitFor();
    return;
  }
  if (setup === 'invalid-reset-token') {
    await page.goto(`${appBaseUrl}/reset-password?token=invalid`);
    await page.locator('#new-password').fill(PASSWORD);
    await page.locator('#reset-password-screen button[type="submit"]').click();
    await page.getByRole('alert').waitFor({ state: 'visible' });
    return;
  }
  if (setup === 'password-reset-request') {
    const account = await createVerifiedAccount(page);
    await page.goto('/forgot-password');
    await page.locator('#recovery-email').fill(account.email);
    await page.getByRole('button', { name: 'Send the link' }).click();
    await page.waitForURL('**/reset-password?sent=1');
    await page.getByRole('status').waitFor({ state: 'visible' });
    return '/reset-password?sent=1';
  }
  if (setup === 'none' || setup.startsWith('native-')) {
    return;
  }
  throw new Error(`No fixture setup is registered for scenario setup ${JSON.stringify(setup)}.`);
};

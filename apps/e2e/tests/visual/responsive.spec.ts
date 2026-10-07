import { expect, test } from '@playwright/test';
import { createVerifiedAccount } from '../../src/fixtures/accounts.ts';

test('keyboard focus, reduced motion, enlarged text and narrow portrait/landscape layouts remain usable', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();

  await page.keyboard.press('Tab');
  const focused = page.locator(':focus');
  await expect(focused).toHaveCount(1);
  await expect(focused).toBeVisible();
  const focusedRole = await focused.evaluate(
    (element) => element.getAttribute('role') ?? element.tagName.toLowerCase(),
  );
  expect(focusedRole).not.toBe('body');

  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  const portraitOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(portraitOverflow).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 844, height: 390 });
  const landscapeOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(landscapeOverflow).toBeLessThanOrEqual(1);

  await createVerifiedAccount(page);
  const refresh = page.getByTestId('notes-refresh');
  await expect(refresh).toBeEnabled();
  const pending = Promise.withResolvers<void>();
  await page.route('**/api/notes', async (route) => {
    await pending.promise;
    await route.abort();
  });
  try {
    await refresh.click();
    const spinner = page.locator('.ui-spinner__ring');
    await expect(spinner).toBeVisible();
    // The shared spinner slows its cycle from 700ms to 2400ms for reduced motion.
    await expect(spinner).toHaveCSS('animation-duration', '2.4s');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(spinner).toHaveCSS('animation-duration', '0.7s');
  } finally {
    pending.resolve();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

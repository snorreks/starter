import { expect, test } from '@playwright/test';

test('keyboard focus, reduced motion, enlarged text and narrow portrait/landscape layouts remain usable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);

  await page.keyboard.press('Tab');
  const focused = page.locator(':focus');
  await expect(focused).toHaveCount(1);
  await expect(focused).toBeVisible();
  const focusedRole = await focused.evaluate((element) => element.getAttribute('role') ?? element.tagName.toLowerCase());
  expect(focusedRole).not.toBe('body');

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  const portraitOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(portraitOverflow).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 844, height: 390 });
  const landscapeOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(landscapeOverflow).toBeLessThanOrEqual(1);
});

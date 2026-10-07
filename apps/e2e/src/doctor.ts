import { chromium } from '@playwright/test';
import { playwrightLaunchOptions } from '../../../scripts/src/shared/browser_path.ts';

const browser = await chromium.launch({ headless: true, ...playwrightLaunchOptions() });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><title>E2E doctor</title><h1>Chromium is ready</h1>');
  const title = await page.title();
  if (title !== 'E2E doctor') throw new Error('Chromium launched but the browser probe did not render its fixture.');
  process.stdout.write(`Chromium launch and page probe passed (${browser.version()}).\n`);
} finally {
  await browser.close();
}

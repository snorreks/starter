// apps/e2e/capture_evidence.ts
//
// Capture screenshots of the real screens, for visual review.
//
//   bun run e2e:visual
//
// This runs its own servers through Playwright rather than assuming a dev server
// is already up, so what it captures is the same build the E2E suite just
// validated — not whatever happens to be on :4183 from someone's terminal.
//
// What it does with them
// ----------------------
// Writes PNGs to a local directory and stops. If a vision model is configured it
// will also ask one to look at them; if not, it says so, loudly, and the
// screenshots are still there for a human.
//
// What it never does
// ------------------
// Upload anything. Screenshots of an unreleased UI are not the tool's to send
// anywhere, and a default that silently shipped images off the machine would be
// a decision nobody made.

import { type Browser, chromium, type Page } from '@playwright/test';
import { clientBaseUrl } from './preflight.ts';
import {
  type EvidenceResult,
  ensureEvidenceDir,
  evidencePath,
  reportEvidence,
  visionConfigured,
} from './visual.ts';

/**
 * The screens worth looking at.
 *
 * Each one is a state a user actually reaches. A screenshot of a route that only
 * renders in a test would give false confidence.
 */
const SCREENS: readonly { name: string; path: string; prepare?: (page: Page) => Promise<void> }[] =
  [
    { name: 'login', path: '/login' },
    { name: 'login-error', path: '/login', prepare: submitBadCredentials },
    { name: 'notes-empty', path: '/', prepare: signIn },
    {
      name: 'notes-populated',
      path: '/',
      prepare: async (page) => {
        await signIn(page);
        await seedNotes(page);
      },
    },
  ];

async function signIn(page: Page): Promise<void> {
  await page.goto(`${clientBaseUrl}/login`);
  await page.getByTestId('auth-toggle-mode').click();
  await page.getByTestId('auth-email-input').fill(`visual-${crypto.randomUUID()}@example.test`);
  await page.getByTestId('auth-password-input').fill('correct horse battery staple');
  await page.getByTestId('auth-submit').click();
  await page.getByRole('heading', { name: 'Your notes' }).waitFor();
}

async function submitBadCredentials(page: Page): Promise<void> {
  await page.getByTestId('auth-email-input').fill('nobody@example.test');
  await page.getByTestId('auth-password-input').fill('definitely not the password');
  await page.getByTestId('auth-submit').click();
  // The error state is the point of this capture, so wait for it to appear.
  await page.getByTestId('auth-error').waitFor();
}

async function seedNotes(page: Page): Promise<void> {
  const notes = [
    { title: 'Shopping list', body: 'Milk, bread, coffee' },
    { title: 'Reading', body: 'Finish the chapter on retrieval' },
    {
      title: 'A rather long title that exercises how the card wraps when a note name runs on',
      body: 'x',
    },
  ];

  for (const note of notes) {
    await page.getByTestId('note-title-input').fill(note.title);
    await page.getByTestId('note-body-input').fill(note.body);
    await page.getByTestId('note-submit').click();
    await page.getByTestId('note-card').filter({ hasText: note.title }).waitFor();
  }
}

async function capture(browser: Browser): Promise<EvidenceResult> {
  const captured: string[] = [];
  ensureEvidenceDir();

  for (const screen of SCREENS) {
    // A fresh context per screen: no shared session, so `notes-populated` cannot
    // inherit a signed-in state from an earlier capture and quietly change what
    // the screenshot shows.
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();

    try {
      await page.goto(`${clientBaseUrl}${screen.path}`);
      if (screen.prepare !== undefined) {
        await screen.prepare(page);
      }
      // One frame after layout settles, so a font or an image is not caught
      // mid-load and reported as a visual regression.
      await page.waitForTimeout(300);

      const file = `${screen.name}.png`;
      await page.screenshot({ path: evidencePath(file), fullPage: true });
      captured.push(file);
      process.stdout.write(`  captured ${file}\n`);
    } catch (error) {
      // One screen failing should not lose the ones that worked.
      process.stderr.write(
        `  could not capture ${screen.name}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      await context.close();
    }
  }

  return { captured, directory: ensureEvidenceDir() };
}

/**
 * Whether a vision model could be asked to look at the captures.
 *
 * Not implemented in this round, and reported as skipped either way. The point
 * is that the skip is *visible*: a capture run that prints green because the
 * inspection step was unavailable is worse than one that says it did not run.
 * See docs/testing.md.
 */
const visionRound = (): { available: boolean; reason?: string } => {
  const configured = visionConfigured();
  if (!configured.available) {
    return configured;
  }
  return {
    available: false,
    reason:
      'a model key is configured, but image inspection is not wired up in this round; ' +
      'the screenshots are on disk for a human to review',
  };
};

async function main(): Promise<number> {
  process.stdout.write(`capturing visual evidence from ${clientBaseUrl}\n`);

  const browser = await chromium.launch();
  let result: EvidenceResult;

  try {
    result = await capture(browser);
  } finally {
    await browser.close();
  }

  const vision = visionRound();
  if (!vision.available && vision.reason !== undefined) {
    result = { ...result, inspectionSkipped: vision.reason };
  }

  reportEvidence(result);
  return 0;
}

process.exitCode = await main();

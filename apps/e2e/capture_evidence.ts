// apps/e2e/capture_evidence.ts
//
// Capture screenshots of the real screens, for visual review.
//
//   bun run e2e:visual
//
// It captures the same built Worker the E2E suite validates. It does not start
// one: run `bun run dev:worker` first, or let `bun run e2e` start it. What it
// captures is therefore the compiled Worker rather than whatever happens to be
// listening on the port.
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
import { playwrightLaunchOptions } from '../../scripts/src/shared/browser_path.ts';
import { appBaseUrl } from './preflight.ts';
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
    { name: 'landing', path: '/' },
    { name: 'login', path: '/login' },
    { name: 'login-error', path: '/login', prepare: submitBadCredentials },
    { name: 'notes-empty', path: '/notes', prepare: signIn },
    {
      name: 'notes-populated',
      path: '/notes',
      prepare: async (page) => {
        await signIn(page);
        await seedNotes(page);
      },
    },
  ];

async function signIn(page: Page): Promise<void> {
  await page.goto(`${appBaseUrl}/login`);
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
      await page.goto(`${appBaseUrl}${screen.path}`);
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
  process.stdout.write(`capturing visual evidence from ${appBaseUrl}\n`);

  // Through the shared resolver, exactly as `playwright.config.ts` does it. A bare
  // `chromium.launch()` uses Playwright's own resolution, which finds the cached
  // download and launches it — on a Nix host that binary cannot load its shared
  // libraries, so this command failed with
  //
  //   error while loading shared libraries: libglib-2.0.so.0
  //
  // while the E2E suite beside it passed, because the suite was given the Nix
  // Chromium. One browser-resolution path, shared by both callers, is the whole
  // fix; re-deciding it here is what let the two disagree.
  const browser = await chromium.launch(playwrightLaunchOptions());
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

  // Zero captures is not a run that captured nothing and succeeded. Every screen
  // failing is nearly always one cause — the app is not running on this origin —
  // and reporting that as "screenshots are on disk for a human" is the specific
  // lie this command must not tell. Per-screen failures are still tolerated:
  // losing one screen is not losing the run.
  if (result.captured.length === 0) {
    process.stderr.write(
      `\nNo screen was captured from ${appBaseUrl}, and the evidence directory is empty.\n` +
        '  Nothing is running on that origin, or every screen failed to load.\n' +
        '  Start the app first: bun run dev:worker   (or let `bun run e2e` start it)\n',
    );
    return 1;
  }

  return 0;
}

process.exitCode = await main();

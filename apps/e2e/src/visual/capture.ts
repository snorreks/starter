import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Page, TestInfo } from '@playwright/test';
import { UI_SCENARIOS } from '@starter/fixtures';
import { REPO_ROOT } from '../../../../scripts/src/shared/paths.ts';
import type { Scenario } from '../scenarios/manifest.ts';

const controlSelectors: Record<string, string> = {
  email: '[data-testid="auth-email-input"], #recovery-email',
  password: '[data-testid="auth-password-input"]',
  'new-password': '#new-password',
  submit: '[data-testid="auth-submit"], #forgot-password-screen button[type="submit"]',
  'reset-submit': '#reset-password-screen button[type="submit"]',
  'auth-error': '[data-testid="auth-error"]',
  'note-title': '[data-testid="note-title-input"]',
  'note-body': '[data-testid="note-body-input"]',
  'note-submit': '[data-testid="note-submit"]',
  'note-delete': '[data-testid="note-delete"]',
  'new-conversation': '[data-testid="chat-new-submit"]',
  'message-composer': '[data-testid="chat-input"]',
  send: '[data-testid="chat-send"]',
  'home-link': 'a[href="/"]',
  'notes-error': '[data-testid="notes-error"]',
  'jobs-unavailable': '[data-testid="jobs-unavailable"]',
};

export const assertScenario = async (page: Page, scenario: Scenario): Promise<void> => {
  await page.getByRole('heading', { name: scenario.ready.heading, exact: true }).waitFor();
  for (const control of scenario.expected.controls) {
    const selector = controlSelectors[control];
    if (selector === undefined) throw new Error(`No browser selector is registered for ${control}.`);
    await page.locator(selector).first().waitFor({ state: 'visible' });
  }
  for (const expected of scenario.expected.content) {
    if (expected.startsWith('testid:')) {
      await page.getByTestId(expected.slice('testid:'.length)).waitFor({ state: 'visible' });
    } else if (controlSelectors[expected] !== undefined) {
      await page.locator(controlSelectors[expected]).first().waitFor({ state: 'visible' });
    } else {
      await page.getByText(expected, { exact: false }).first().waitFor({ state: 'visible' });
    }
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (overflow) throw new Error(`Horizontal page overflow at ${page.url()}.`);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(
      [...document.images].map((image) =>
        image.complete ? Promise.resolve() : new Promise<void>((resolve) => {
          image.addEventListener('load', () => resolve(), { once: true });
          image.addEventListener('error', () => resolve(), { once: true });
        }),
      ),
    );
  });
};

export const captureScenario = async (
  page: Page,
  scenario: Scenario,
  testInfo: TestInfo,
  url: string,
  accessibility: { violations: number; critical: number; serious: number } | null,
): Promise<void> => {
  const bytes = await page.screenshot({ fullPage: true, animations: 'disabled' });
  const project = testInfo.project.name;
  const metadata = testInfo.config.metadata as Record<string, unknown>;
  const runId = typeof metadata.e2eRunId === 'string' ? metadata.e2eRunId : 'missing-run-id';
  const output = typeof metadata.e2eEvidenceDir === 'string' ? metadata.e2eEvidenceDir : undefined;
  if (output === undefined) throw new Error('Visual capture has no configured artifact directory.');
  const workerPath = join(REPO_ROOT, 'apps/frontend/client/.svelte-kit/cloudflare/_worker.js');
  const workerSha256 = createHash('sha256').update(await readFile(workerPath)).digest('hex');
  const parsedUrl = new URL(url);
  for (const key of [...parsedUrl.searchParams.keys()]) {
    if (/token|code|email|secret|session|credential/i.test(key)) parsedUrl.searchParams.set(key, '[redacted]');
  }
  const browser = page.context().browser();
  const viewport = page.viewportSize();
  const deviceScaleFactor = await page.evaluate(() => window.devicePixelRatio);
  const file = join(output, 'captures', runId, `${scenario.id}--${project}.png`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes, { flag: 'wx' });
  const record = {
    schemaVersion: 1,
    runId,
    scenarioId: scenario.id,
    app: scenario.app,
    state: scenario.state,
    runtimeProfile: scenario.runtimeProfile,
    fixture: scenario.fixture,
    fixtureRevision: createHash('sha256').update(JSON.stringify(UI_SCENARIOS)).digest('hex'),
    workerSha256,
    browserVersion: browser?.version() ?? 'unknown',
    viewport,
    deviceScaleFactor,
    requirements: scenario.visualRequirements,
    expected: scenario.expected,
    heading: scenario.ready.heading,
    accessibility,
    project,
    url: parsedUrl.toString(),
    file,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    status: 'passed',
    ai: 'not-run',
    provenance: 'fresh',
  };
  await writeFile(`${file}.json`, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  await testInfo.attach(`${scenario.id}-${project}`, { body: bytes, contentType: 'image/png' });
};

import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { prepareScenarioContent } from '../../src/fixtures/accounts.ts';
import { readScenarioManifest, type Scenario } from '../../src/scenarios/manifest.ts';
import { assertScenario, captureScenario } from '../../src/visual/capture.ts';

const scenarios = readScenarioManifest().scenarios.filter((scenario) => scenario.capture);

test('the visual manifest has at least one executable capture', () => {
  expect(scenarios.length).toBeGreaterThan(0);
});

for (const scenario of scenarios) {
  test(`${scenario.id}: ${scenario.state}`, async ({ page }, testInfo) => {
    const [viewport, theme] = testInfo.project.name.split('-');
    if (
      !scenario.variants.viewports.includes(viewport as 'desktop' | 'mobile') ||
      !scenario.variants.themes.includes(theme as 'light' | 'dark')
    ) {
      test.skip(true, `Scenario ${scenario.id} does not declare ${testInfo.project.name}.`);
    }
    let target = scenario.url;
    const nativeUrl = testInfo.config.metadata.e2eNativeUrl;
    const appOrigin = scenario.app === 'native' ? nativeUrl : undefined;
    if (scenario.app === 'native' && typeof appOrigin !== 'string') {
      throw new Error('Native visual server identity is missing from E2E_NATIVE_URL.');
    }

    const interactiveSetup = ['invalid-credentials', 'invalid-reset-token'].includes(
      scenario.setup,
    );
    if (interactiveSetup) {
      await prepareScenarioContent(page, scenario.setup);
    } else if (scenario.setup !== 'none' && !scenario.setup.startsWith('native-')) {
      target = (await prepareScenarioContent(page, scenario.setup)) ?? target;
    }

    const finalUrl = `${appOrigin ?? ''}${target}`;
    if (!interactiveSetup) {
      await page.goto(finalUrl);
    }
    const actualUrl = new URL(page.url());
    const expectedUrl = new URL(target, `${appOrigin ?? testInfo.project.use.baseURL}`);
    expect(actualUrl.origin).toBe(expectedUrl.origin);
    expect(actualUrl.pathname).toBe(expectedUrl.pathname);
    expect(actualUrl.search).toBe(expectedUrl.search);
    await assertScenario(page, scenario);
    let accessibility: { violations: number; critical: number; serious: number } | null = null;
    if (scenario.audit) {
      const audit = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .analyze();
      const serious = audit.violations.filter((violation) =>
        ['critical', 'serious'].includes(violation.impact ?? ''),
      );
      accessibility = {
        violations: audit.violations.length,
        critical: audit.violations.filter((violation) => violation.impact === 'critical').length,
        serious: audit.violations.filter((violation) => violation.impact === 'serious').length,
      };
      await testInfo.attach(`${scenario.id}-axe.json`, {
        body: JSON.stringify(
          audit.violations.map(({ id, impact, description, help, nodes }) => ({
            id,
            impact,
            description,
            help,
            nodes,
          })),
          null,
          2,
        ),
        contentType: 'application/json',
      });
      expect(
        serious,
        `Serious or critical axe violations: ${serious.map((item) => item.id).join(', ')}`,
      ).toHaveLength(0);
    }
    await captureScenario(page, scenario, testInfo, page.url(), accessibility);

    if (scenario.baseline) {
      await page.waitForLoadState('networkidle');
      await page.locator('[data-testid="current-user"]').evaluateAll((nodes) => {
        for (const node of nodes) {
          node.textContent = 'Signed-in user';
        }
      });
      if (scenario.app === 'native') {
        await page.addStyleTag({
          content:
            '[data-testid="native-origin"] { position: relative; color: transparent !important; } [data-testid="native-origin"]::after { position: absolute; inset: 0 auto auto 0; content: "API: local Worker"; color: var(--color-text-muted); white-space: nowrap; }',
        });
      }
      await page.locator('time.note-card__updated').evaluateAll((nodes) => {
        for (const node of nodes) {
          node.textContent = 'fixture time';
        }
      });
      await expect(page).toHaveScreenshot(`${scenario.id}.png`, {
        fullPage: true,
        animations: 'disabled',
      });
    }
  });
}

test('uncaptured errors remain explicit in the manifest', () => {
  const error = readScenarioManifest().scenarios.find(
    (scenario: Scenario) => scenario.kind === 'error',
  );
  expect(error?.capture).toBe(false);
  expect(error?.captureReason?.trim()).not.toBe('');
});

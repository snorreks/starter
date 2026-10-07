import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { runBounded } from '../../../../scripts/src/shared/run_bounded.ts';
import { resolveBrowser } from '../../../../scripts/src/shared/browser_path.ts';
import { runScope } from '../../../../scripts/src/shared/run_scope.ts';
import { REPO_ROOT } from '../../../../scripts/src/shared/paths.ts';
import { TEST_RUN_ID, appBaseUrl } from '../../preflight.ts';
import { readScenarioManifest } from '../../src/scenarios/manifest.ts';

const scenarios = readScenarioManifest().scenarios.filter((scenario) =>
  scenario.audit && scenario.app === 'web' && scenario.setup === 'none' && scenario.capture,
);
if (scenarios.length === 0) throw new Error('Lighthouse manifest selection found zero public, auditable scenarios.');
const outputs = join(runScope(TEST_RUN_ID, REPO_ROOT).artifactDir, 'audit');
const lighthouseCli = join(REPO_ROOT, 'apps/e2e/node_modules/lighthouse/cli/index.js');
const browser = resolveBrowser();
if (browser.executable === null) throw new Error(`Lighthouse needs Chromium. ${browser.reason}`);
const chromePath = browser.executable;
await mkdir(outputs, { recursive: true });
const budgets = {
  desktop: { performance: 0.85, accessibility: 0.95, 'best-practices': 0.95, seo: 0.85, lcpMs: 2_500, cls: 0.1, tbtMs: 300, bytes: 250_000, requests: 50 },
  mobile: { performance: 0.8, accessibility: 0.95, 'best-practices': 0.95, seo: 0.85, lcpMs: 3_000, cls: 0.1, tbtMs: 300, bytes: 250_000, requests: 50 },
} as const;

const atomicJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(outputs, { recursive: true });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
};
const median = (numbers: number[]): number => {
  const sorted = [...numbers].sort((a, b) => a - b);
  if (sorted.length !== 3) throw new Error(`A Lighthouse median requires exactly three valid samples; received ${sorted.length}.`);
  return sorted[1] as number;
};

for (const scenario of scenarios) {
  for (const viewport of ['desktop', 'mobile'] as const) {
    test(`${scenario.id}: ${viewport}, three serialized Lighthouse samples`, async ({ request }, testInfo) => {
      const url = new URL(scenario.url, appBaseUrl).toString();
      const route = await request.get(url);
      expect(route.status(), `${scenario.id} must resolve directly to its declared route`).toBe(200);
      const html = await route.text();
      expect(html).toContain(scenario.ready.heading);
      const samples: Array<Record<string, unknown>> = [];
      for (let iteration = 1; iteration <= 3; iteration += 1) {
        const suffix = `${scenario.id}-${viewport}-${iteration}`;
        const reportPath = join(outputs, `${suffix}.json`);
        const form = viewport === 'mobile' ? 'perf' : 'desktop';
        const args = [
          lighthouseCli,
          url,
          '--quiet',
          '--output=json',
          '--only-categories=performance,accessibility,best-practices,seo',
          `--output-path=${reportPath}`,
          `--preset=${form}`,
          '--throttling-method=simulate',
          '--locale=en-US',
          '--chrome-flags=--headless --no-sandbox',
          ...(viewport === 'mobile' ? ['--screenEmulation.mobile=true', '--screenEmulation.width=390', '--screenEmulation.height=844', '--screenEmulation.deviceScaleFactor=1'] : []),
        ];
        const result = await runBounded({
          command: 'node',
          args,
          cwd: REPO_ROOT,
          env: { ...process.env, CHROME_PATH: chromePath },
          timeoutMs: 180_000,
          maxBytes: 256_000,
        });
        if (result.code !== 0) throw new Error(`Lighthouse sample ${suffix} failed (${result.code}): ${result.stderr.slice(-2500)}`);
        const reportBytes = await readFile(reportPath);
        const report = JSON.parse(reportBytes.toString('utf8')) as {
          requestedUrl?: string;
          finalUrl?: string;
          categories?: Record<string, { score?: number | null }>;
          audits?: Record<string, { numericValue?: number; details?: { items?: unknown[] } }>;
          userAgent?: string;
          lighthouseVersion?: string;
        };
        if (report.requestedUrl !== url || report.finalUrl !== url) {
          throw new Error(`Lighthouse audited a redirected or unexpected URL for ${suffix}: ${report.finalUrl ?? 'missing finalUrl'}.`);
        }
        const metric = (id: string): number => {
          const value = report.audits?.[id]?.numericValue;
          if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Lighthouse sample ${suffix} omitted required metric ${id}.`);
          return value;
        };
        const scores = Object.fromEntries(['performance', 'accessibility', 'best-practices', 'seo'].map((category) => {
          const score = report.categories?.[category]?.score;
          if (typeof score !== 'number') throw new Error(`Lighthouse sample ${suffix} omitted category ${category}.`);
          return [category, score];
        }));
        const sample = {
          schemaVersion: 1,
          runId: TEST_RUN_ID,
          scenario: scenario.id,
          url,
          viewport,
          iteration,
          lighthouseVersion: report.lighthouseVersion,
          userAgent: report.userAgent,
          scores,
          metrics: {
            lcpMs: metric('largest-contentful-paint'),
            cls: metric('cumulative-layout-shift'),
            tbtMs: metric('total-blocking-time'),
            bytes: metric('total-byte-weight'),
            requests: report.audits?.['network-requests']?.details?.items?.length ?? null,
          },
          reportSha256: createHash('sha256').update(reportBytes).digest('hex'),
          status: 'valid',
        };
        samples.push(sample);
        await atomicJson(join(outputs, `${suffix}.summary.json`), sample);
      }
      if (samples.length !== 3) throw new Error(`Audit target ${scenario.id}/${viewport} has fewer than three valid samples.`);
      const metricKeys = ['performance', 'accessibility', 'best-practices', 'seo'] as const;
      const scoreValues = (sample: Record<string, unknown>, key: string): number => {
        const value = (sample.scores as Record<string, number>)[key];
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`A Lighthouse sample omitted category ${key}.`);
        return value;
      };
      const categories = Object.fromEntries(metricKeys.map((key) => [key, median(samples.map((sample) => scoreValues(sample, key)))]));
      const metrics = Object.fromEntries(['lcpMs', 'cls', 'tbtMs', 'bytes', 'requests'].map((key) => [key, median(samples.map((sample) => {
        const value = (sample.metrics as Record<string, number>)[key];
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`A Lighthouse sample omitted required metric ${key}.`);
        return value;
      }))]));
      const budget = budgets[viewport];
      const checks = Object.fromEntries(Object.entries(budget).map(([key, limit]) => {
        const categoryValue = (categories as Record<string, number>)[key];
        const actual = categoryValue ?? (metrics as Record<string, number>)[key];
        if (typeof actual !== 'number') throw new Error(`No Lighthouse value was recorded for budget ${key}.`);
        return [key, { actual, limit, status: categoryValue !== undefined ? (actual >= limit ? 'passed' : 'failed') : (actual <= limit ? 'passed' : 'failed') }];
      }));
      const failedBudgets = Object.entries(checks).filter(([, value]) => value.status === 'failed').map(([key]) => key);
      await atomicJson(join(outputs, `${scenario.id}-${viewport}.json`), {
        schemaVersion: 1,
        runId: TEST_RUN_ID,
        scenario: scenario.id,
        url,
        viewport,
        sampleCount: samples.length,
        aggregation: 'median-of-three-serialized-valid-runs',
        categories,
        metrics,
        budgetStatus: failedBudgets.length === 0 ? 'passed' : 'failed',
        budgetsProvisional: true,
        budgetChecks: checks,
        samples: samples.map(({ iteration, reportSha256, status }) => ({ iteration, reportSha256, status })),
      });
      await testInfo.attach(`${scenario.id}-${viewport}-median.json`, {
        path: join(outputs, `${scenario.id}-${viewport}.json`),
        contentType: 'application/json',
      });
      expect(failedBudgets, `Provisional Lighthouse budgets failed: ${failedBudgets.join(', ')}`).toEqual([]);
    });
  }
}

import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import baseConfig, { TEST_RUN_ID } from './playwright.config.ts';
import { runScope } from '../../scripts/src/shared/run_scope.ts';

const scope = runScope(TEST_RUN_ID);
const base = baseConfig as PlaywrightTestConfig;
export default defineConfig({
  ...base,
  testDir: './tests/audit',
  outputDir: `${scope.artifactDir}/playwright-audit`,
  fullyParallel: false,
  workers: 1,
  timeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
});

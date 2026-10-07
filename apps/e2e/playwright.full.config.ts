import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';
import { runScope } from '../../scripts/src/shared/run_scope.ts';
import baseConfig, { APP_PORT, TEST_RUN_ID } from './playwright.config.ts';

const scope = runScope(TEST_RUN_ID);
const base = baseConfig as PlaywrightTestConfig;

export default defineConfig({
  ...base,
  testDir: './tests/full',
  testIgnore: [],
  outputDir: `${scope.artifactDir}/playwright-full`,
  metadata: { ...base.metadata, e2eFullRunId: TEST_RUN_ID },
  globalTeardown: './full-global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 120_000 },
  webServer: [
    {
      command: 'bun run full:runtime',
      cwd: process.cwd(),
      url: `http://127.0.0.1:${APP_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 30 * 60_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        E2E_RUN_ID: TEST_RUN_ID,
        E2E_APP_PORT: String(APP_PORT),
        E2E_RUN_INITIALIZED: '1',
      },
    },
  ],
});

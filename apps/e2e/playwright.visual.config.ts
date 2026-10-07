import { fileURLToPath } from 'node:url';
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';
import { playwrightLaunchOptions } from '../../scripts/src/shared/browser_path.ts';
import { resolveE2EPort } from '../../scripts/src/shared/e2e_port.ts';
import { REPO_ROOT } from '../../scripts/src/shared/paths.ts';
import { runScope } from '../../scripts/src/shared/run_scope.ts';

const runId = process.env.E2E_RUN_ID ?? `visual_${crypto.randomUUID()}`;
if (process.env.CI && process.argv.includes('--update-snapshots')) {
  throw new Error(
    'Visual snapshot updates are refused in CI. Run e2e:visual -- --update-snapshots locally and review the diff.',
  );
}
process.env.E2E_RUN_ID = runId;
const nativePort = await resolveE2EPort(`${runId}_native`, process.env.E2E_NATIVE_PORT, REPO_ROOT);
const nativeUrl = `http://127.0.0.1:${nativePort}`;
process.env.E2E_NATIVE_URL = nativeUrl;
process.env.E2E_EXTRA_TRUSTED_ORIGINS = nativeUrl;
const scope = runScope(runId);
process.env.E2E_EVIDENCE_DIR = `${scope.artifactDir}/visual`;
const { default: baseConfig, appBaseUrl } = await import('./playwright.config.ts');
const base = baseConfig as PlaywrightTestConfig;
const launchOptions = playwrightLaunchOptions();
const baseServers: NonNullable<PlaywrightTestConfig['webServer']> = [];
if (Array.isArray(base.webServer)) {
  baseServers.push(...base.webServer);
} else if (base.webServer !== undefined) {
  baseServers.push(base.webServer);
}

export default defineConfig({
  ...base,
  testDir: './tests/visual',
  testIgnore: [],
  outputDir: `${scope.artifactDir}/playwright-visual`,
  metadata: {
    e2eRunId: runId,
    e2eNativeUrl: nativeUrl,
    e2eEvidenceDir: `${scope.artifactDir}/visual`,
  },
  fullyParallel: false,
  workers: 1,
  reporter: [['list'], ['./src/visual/reporter.ts']],
  projects: (['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark'] as const).map(
    (name) => {
      const mobile = name.startsWith('mobile');
      const dark = name.endsWith('dark');
      return {
        name,
        use: {
          ...devices['Desktop Chrome'],
          browserName: 'chromium',
          launchOptions,
          viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
          deviceScaleFactor: 1,
          isMobile: false,
          hasTouch: mobile,
          colorScheme: dark ? 'dark' : 'light',
          locale: 'en-US',
          timezoneId: 'Europe/Oslo',
        },
      };
    },
  ),
  webServer: [
    ...baseServers,
    {
      command: `bun run dev -- --host 127.0.0.1 --port ${nativePort} --strictPort`,
      cwd: fileURLToPath(new URL('../frontend/native', import.meta.url)),
      url: nativeUrl,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe' as const,
      stderr: 'pipe' as const,
      env: {
        NATIVE_DEV_PORT: String(nativePort),
        NATIVE_DEV_HOST: '127.0.0.1',
        VITE_NATIVE_API_ORIGIN: appBaseUrl,
      },
    },
  ],
});

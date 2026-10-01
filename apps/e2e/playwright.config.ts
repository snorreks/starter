// apps/e2e/playwright.config.ts
//
// End-to-end tests against a real client and a real API.
//
// This suite runs the actual built client against the actual Worker with a real
// local D1. That is deliberate and expensive: it is the only lane that can catch
// a contract mismatch between the two, a proxy misconfiguration, or a build that
// only works in dev. The unit and browser lanes cannot see any of those.
//
// Two decisions worth stating:
//
//   1. It runs against the **built** client, not the dev server. A build-only
//      failure — an import that only resolves under Vite's dev transform, a
//      Svelte SSR crash — is invisible to every other lane and is exactly the
//      kind of thing that reaches a deploy.
//
//   2. `webServer` starts both processes and waits for readiness. Playwright's
//      own wait is on the *server*; `global-setup.ts` additionally proves the API
//      is the one this run started, not a leftover from a previous run. See
//      `preflight.ts` for why that distinction matters.

import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * Which Chromium this run uses.
 *
 * `CHROMIUM_PATH` is set by the Nix dev shell, because Playwright's own download
 * links against a Linux libc and a fixed set of `.so` names that NixOS only
 * provides under versioned suffixes. Left unset, Playwright uses its downloaded
 * copy — correct everywhere else.
 *
 * `new URL(...).pathname` is never used on a path in this file: it
 * percent-encodes, so a checkout under a directory containing a space resolves
 * to a nonexistent location and the failure reads as a missing file.
 */
const chromiumPath = process.env.CHROMIUM_PATH;
const launchOptions = chromiumPath ? { executablePath: chromiumPath } : {};

/**
 * Ports.
 *
 * Fixed rather than ephemeral, and overridable by environment variable. A
 * leftover process on a fixed port is a real hazard (the integration suite hit
 * it), which is why `preflight.ts` refuses to continue if something is already
 * listening rather than silently testing against it.
 */
const CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT ?? 4183);
const API_PORT = Number(process.env.E2E_API_PORT ?? 8788);

const clientBaseUrl = `http://127.0.0.1:${CLIENT_PORT}`;
const apiBaseUrl = `http://127.0.0.1:${API_PORT}`;

/**
 * This run's id, generated here at module load.
 *
 * It has to be here rather than in `global-setup.ts`: Playwright loads the config
 * file *before* running global setup, so anything global-setup writes to
 * `process.env` is already too late for the `webServer[].env` block below. That
 * ordering cost a debugging cycle once — the Worker started with no run id and
 * the preflight correctly refused to proceed.
 *
 * `global-setup.ts` imports this value, so both halves agree by construction
 * rather than by a value being passed between them.
 */
export const TEST_RUN_ID = `e2e_${crypto.randomUUID()}`;

/**
 * Sign-in budget for the run.
 *
 * Raised, not disabled. Each test creates its own account, so a full run makes
 * roughly a dozen sign-ups in a couple of minutes — well past a
 * production-sane per-minute budget. Leaving it at the default would make every
 * test after the third fail with a rate-limit error and report a product bug.
 *
 * Setting it to 0 would be worse: it would prove nothing about the auth path a
 * real user takes, and a rate-limit bypass is exactly the kind of thing that
 * should not be normal in a test environment.
 */
export const AUTH_RATE_LIMIT_MAX = '500';

/**
 * Origins the API will accept credentialed requests from.
 *
 * Better Auth rejects a request whose `Origin` is not on this list, and the
 * Worker applies the same allowlist before it reaches the handler. The E2E
 * client runs on its own port, so it has to be named here explicitly — a
 * wildcard would defeat the point of an allowlist.
 */
export const TRUSTED_ORIGINS = [
  `http://127.0.0.1:${CLIENT_PORT}`,
  `http://localhost:${CLIENT_PORT}`,
];

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  // Screenshots of failures only: a full-page shot per test would fill a disk
  // with images of a working application.
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // One worker. These tests share one local D1 file and one set of seeded users;
  // running them concurrently would have them authenticating over each other.
  workers: 1,
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]]
    : [['list']],

  use: {
    baseURL: clientBaseUrl,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions },
    },
  ],

  webServer: [
    {
      // The API first: the client's proxy needs it, and Playwright starts these
      // in order, so the API is listening before the client is asked for.
      command: `bun run dev:api`,
      url: `${apiBaseUrl}/api/health`,
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        API_PORT: String(API_PORT),
        STARTER_LOG_DIR: process.env.STARTER_LOG_DIR ?? '/tmp/starter-logs',
        // Playwright's `webServer.env` *replaces* the inherited environment
        // rather than merging with it, so anything the API needs must be listed
        // here explicitly — including this, which the preflight compares against.
        TEST_RUN_ID,
        AUTH_RATE_LIMIT_MAX,
        TRUSTED_ORIGINS: TRUSTED_ORIGINS.join(','),
      },
    },
    {
      command: `bun run build && bun run preview --port ${CLIENT_PORT} --host 127.0.0.1`,
      url: clientBaseUrl,
      // Against the built output, not `vite dev`. A dev-only success would make
      // this lane certify something the deploy does not do.
      cwd: fileURLToPath(new URL('../frontend/client', import.meta.url)),
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        // The client resolves its API proxy target from `API_PORT` at config
        // load. Without this the preview proxy points at 8787 while the Worker
        // listens on 8788, and every auth request comes back 502 — which reaches
        // the user as a sign-in form reading "The request failed", with nothing
        // in the browser to explain it.
        API_PORT: String(API_PORT),
      },
    },
  ],

  globalSetup: './global-setup.ts',
});

export { apiBaseUrl, clientBaseUrl };

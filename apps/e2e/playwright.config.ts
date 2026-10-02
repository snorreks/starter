// apps/e2e/playwright.config.ts
//
// End-to-end tests against the real application.
//
// This suite runs the **built** Worker in real workerd with a real local D1, and
// drives it in a real browser. That is deliberate and expensive: it is the only
// lane that can catch a contract mismatch between the page and the API, a
// bundling mistake that only appears in workerd, or a build that only works in
// dev. The unit and browser lanes cannot see any of those.
//
// Two decisions worth stating:
//
//   1. It runs against the **built** output, served by `wrangler dev` on
//      `.svelte-kit/cloudflare/_worker.js`. A dev-only success would make this lane
//      certify something the deploy does not do — and a bundling mistake, an import
//      that only resolves under Vite's dev transform, or an Svelte SSR crash is
//      invisible to every other lane.
//
//   2. **One server, one origin.** The page, the assets and `/api/*` are all
//      served by that one Worker, so there is no proxy and no second process to
//      start. The suite used to start `wrangler dev` for the API and a `vite
//      preview` for the client, and prove the API it reached was its own through an
//      identity assertion. That assertion is still worth making — a stale listener
//      answers a health check as readily as the right process — so it is kept, and
//      `global-setup.ts` still runs before any test.
//
// The server's public origin is the one thing the application cannot know for
// itself, so the run id and the auth secret are passed as Worker vars. `bun run
// dev:worker` is the one launcher that turns environment variables into `wrangler
// dev --var` flags, so the harness sets environment variables and does not have a
// second implementation of that translation. It is also why the pid file, the log
// capture and the signal handling work identically for the E2E lane and for a
// human running `bun run dev`.

import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { playwrightLaunchOptions } from '../../scripts/src/shared/browser_path.ts';
import { worktreePort } from '../../scripts/src/shared/run_scope.ts';

/**
 * Which Chromium this run uses.
 *
 * Resolved by `scripts/src/shared/browser_path.ts` — the same module the Vitest
 * browser lane reads — so the two lanes cannot disagree about the executable.
 *
 * It used to be read here as a bare `process.env.CHROMIUM_PATH ? … : {}`. That
 * is not equivalent: the shared resolver also finds a browser in a Playwright
 * cache when no variable is set, which is the normal case on a non-Nix host,
 * and it names the missing prerequisite when there is none. Two answers to one
 * question is how the browser lane ended up failing while E2E passed.
 *
 * `new URL(...).pathname` is never used on a path in this file: it
 * percent-encodes, so a checkout under a directory containing a space resolves
 * to a nonexistent location and the failure reads as a missing file.
 */
const launchOptions = playwrightLaunchOptions();

/**
 * Port.
 *
 * One, because there is one server. Derived from the **repository root** by
 * `worktreePort`, so two worktrees — a Herdr worktree, a second clone, a CI matrix
 * leg — do not fight over one port, and the same checkout always gets the same one.
 * A fixed 4183 was shared by every checkout on the machine, and the failure that
 * produced is silent: the second run starts nothing, connects to the first one's
 * server, and every spec passes against a stale D1.
 *
 * The key is the repository root, deliberately, not this file's directory.
 * `apps/e2e` has the same path suffix in every checkout, so keying on
 * `import.meta.dirname` derives the *same* port for two checkouts — which is the
 * collision this exists to remove. The default argument is the repository root, so
 * passing nothing is what keeps the two apart.
 *
 * `E2E_APP_PORT` still wins, for a deliberate port choice — but only when it is
 * non-empty. `Number('')` is `0`, which asks the OS for an arbitrary port that the
 * preflight then cannot find, and `E2E_APP_PORT=` is exactly the shape a CI variable
 * takes when it is declared and left unset.
 *
 * The port is still only *chosen* here; `preflight.ts` proves the server answering
 * on it is this run's, by run id. Allocation and identity are separate checks on
 * purpose: the port says where to look, the run id says who answered.
 */
const explicitPort = process.env.E2E_APP_PORT;
export const APP_PORT =
  explicitPort === undefined || explicitPort === '' ? worktreePort(4183) : Number(explicitPort);

const appBaseUrl = `http://127.0.0.1:${APP_PORT}`;

/**
 * This run's id, generated here at module load.
 *
 * It has to be here rather than in `global-setup.ts`: Playwright loads the config
 * file *before* running global setup, so anything global-setup writes to
 * `process.env` is already too late for the `webServer[].env` block below. That
 * ordering cost a debugging cycle once — the Worker started with no run id and the
 * preflight correctly refused to proceed.
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

export default defineConfig({
  testDir: './tests',
  outputDir: './test-results',
  // Screenshots of failures only: a full-page shot per test would fill a disk
  // with images of a working application.
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  // One worker. These tests share one local database and one set of seeded users;
  // running them concurrently would have them authenticating over each other.
  workers: 1,
  reporter: process.env.CI
    ? [['list'], ['html', { outputFolder: './playwright-report', open: 'never' }]]
    : [['list']],

  use: {
    baseURL: appBaseUrl,
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
      // Build, then serve the built Worker in the real runtime. The build is part of
      // this command rather than a separate `dependsOn` because the artifact under
      // test is the build output: a stale `.svelte-kit/cloudflare` from a previous
      // command would make this lane certify code nobody just compiled.
      command: `bun run build && bun run --cwd ../.. dev:worker`,
      // Against the app itself, not `vite dev`. A dev-only success would make this
      // lane certify something the deploy does not do.
      url: appBaseUrl,
      cwd: fileURLToPath(new URL('../frontend/client', import.meta.url)),
      reuseExistingServer: false,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PORT: String(APP_PORT),
        // Playwright's `webServer.env` *replaces* the inherited environment rather
        // than merging with it, so anything the Worker needs must be listed here
        // explicitly — including these, which the preflight compares against.
        TEST_RUN_ID,
        AUTH_RATE_LIMIT_MAX,
        // The sign-in rate limit is real and stays on; the budget is raised for the
        // run rather than disabled, for the reasons documented in playwright.config.
        BETTER_AUTH_SECRET: 'e2e-secret-not-for-production-use-at-all-000',
        // Origins the app will accept credentialed requests from. There is no
        // cross-origin client any more, so the list names only the app's own
        // origin — an allowlist with one entry is still an allowlist, and Better
        // Auth rejects a request whose `Origin` is not on it.
        TRUSTED_ORIGINS: appBaseUrl,
      },
    },
  ],

  globalSetup: './global-setup.ts',
});

export { appBaseUrl };

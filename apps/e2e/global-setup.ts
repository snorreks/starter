// apps/e2e/global-setup.ts
//
// Runs once, before Playwright starts any server.
//
// Its whole job is to make the identity check possible. A server started on a fixed
// port has to be provably *this run's*: a leftover listener answers `/api/health`
// just as readily as a correct one, and a readiness probe that only checks for a 200
// will run a whole suite against the wrong process — passing, and proving nothing.
//
// The run id is generated in `playwright.config.ts`, not here. Playwright loads the
// config file *before* running global setup, so a value set in `process.env` here is
// already too late for the `webServer[].env` block that has to forward it to the
// Worker. Importing it keeps the two halves agreeing by construction.
//
// If preflight fails, this throws: a failed setup aborts the run rather than
// letting tests execute against an unverified server.

import { TEST_RUN_ID } from './playwright.config.ts';
import { APP_PORT, appBaseUrl, recordIdentity, verifyAppIdentity } from './preflight.ts';

export default async function globalSetup(): Promise<void> {
  process.stdout.write(`e2e run id: ${TEST_RUN_ID}\n`);

  recordIdentity({
    runId: TEST_RUN_ID,
    appBaseUrl,
    appPort: APP_PORT,
  });

  const result = await verifyAppIdentity(appBaseUrl, TEST_RUN_ID);

  if (!result.ok) {
    throw new Error(`\nE2E preflight failed.\n\n  ${result.reason}\n\n  ${result.remedy}\n`);
  }

  process.stdout.write(`e2e preflight ok: the app on ${appBaseUrl} is this run's server\n`);
}

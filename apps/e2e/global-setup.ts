// apps/e2e/global-setup.ts
//
// Runs once, before Playwright starts any server.
//
// Its whole job is to make the identity check possible. A Worker started on a
// fixed port has to be provably *this run's* Worker: a leftover listener answers
// `/api/health` just as readily as a correct one, and a readiness probe that only
// checks for a 200 will run a whole suite against the wrong process — passing,
// and proving nothing.
//
// The run id is generated in `playwright.config.ts`, not here. Playwright loads
// the config file *before* running global setup, so a value set in `process.env`
// here is already too late for the `webServer[].env` block that has to forward it
// to the Worker. Importing it keeps the two halves agreeing by construction.
//
// If preflight fails, this throws: a failed setup aborts the run rather than
// letting tests execute against an unverified API.

import { TEST_RUN_ID } from './playwright.config.ts';
import { apiBaseUrl, clientBaseUrl, recordIdentity, verifyApiIdentity } from './preflight.ts';

export default async function globalSetup(): Promise<void> {
  process.stdout.write(`e2e run id: ${TEST_RUN_ID}\n`);

  recordIdentity({
    runId: TEST_RUN_ID,
    apiBaseUrl,
    clientBaseUrl,
    apiPort: Number(new URL(apiBaseUrl).port),
    clientPort: Number(new URL(clientBaseUrl).port),
  });

  const result = await verifyApiIdentity(apiBaseUrl, TEST_RUN_ID);

  if (!result.ok) {
    throw new Error(`\nE2E preflight failed.\n\n  ${result.reason}\n\n  ${result.remedy}\n`);
  }

  process.stdout.write(`e2e preflight ok: the api on ${apiBaseUrl} is this run's worker\n`);
}

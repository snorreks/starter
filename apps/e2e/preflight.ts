// apps/e2e/preflight.ts
//
// Proving this run's servers are this run's servers.
//
// The problem this exists to solve: a leftover `wrangler dev` from an earlier
// command keeps port 8787. Playwright's `webServer` sees the port answer and —
// depending on version and reuse settings — either fails confusingly or, worse,
// *passes*, running every test against the stale process. That stale process has
// a stale D1 with a stale schema and stale seeded users. The suite then reports a
// product bug that is actually a leftover socket.
//
// The check is an identity assertion, not a liveness assertion. The API echoes a
// run id; global-setup sends a fresh one and requires it back. A server that
// cannot prove it is the one just started is not used.
//
// (`pkill -f wrangler` is deliberately not used anywhere: the pattern broad
// enough to match the dev server also matches the shell that launched it, which
// kills the caller.)

import { join } from 'node:path';

export type RunIdentity = {
  /** Unique per Playwright invocation. */
  runId: string;
  apiBaseUrl: string;
  clientBaseUrl: string;
  apiPort: number;
  clientPort: number;
};

export const CLIENT_PORT = Number(process.env.E2E_CLIENT_PORT ?? 4183);
export const API_PORT = Number(process.env.E2E_API_PORT ?? 8788);

export const clientBaseUrl = `http://127.0.0.1:${CLIENT_PORT}`;
export const apiBaseUrl = `http://127.0.0.1:${API_PORT}`;

let currentRun: RunIdentity | undefined;

export const currentIdentity = (): RunIdentity => {
  if (currentRun === undefined) {
    throw new Error('currentIdentity() called before global-setup completed.');
  }
  return currentRun;
};

export type PreflightFailure = {
  ok: false;
  reason: string;
  remedy: string;
};

export type PreflightSuccess = { ok: true; runId: string };

/**
 * Verify the API is this run's API.
 *
 * The Worker reports `testRunId` from its `TEST_RUN_ID` binding when one is set,
 * so this harness generates the id, puts it in the environment the API inherits,
 * and requires `/api/health` to report the same value.
 *
 * A stale listener answers `/api/health` just as readily as a correct one. A
 * readiness probe that only checks for a 200 will run a whole suite against the
 * wrong process — passing, and proving nothing.
 *
 * A *missing* id is also a failure, not something to pass through: it means
 * either a leftover server from before this feature, or an API started without
 * the binding. Both mean this suite would not be testing what it claims to.
 */
export const verifyApiIdentity = async (
  baseUrl: string = apiBaseUrl,
  expectedRunId: string = currentIdentity().runId,
  timeoutMs = 60_000,
): Promise<PreflightSuccess | PreflightFailure> => {
  if (expectedRunId.length === 0) {
    throw new Error('verifyApiIdentity needs a run id to compare against.');
  }
  const deadline = Date.now() + timeoutMs;

  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`, {
        signal: AbortSignal.timeout(5_000),
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status}`;
      } else {
        const body = (await response.json()) as { testRunId?: unknown };
        const port = new URL(baseUrl).port;

        if (body.testRunId === expectedRunId) {
          return { ok: true, runId: expectedRunId };
        }

        // A different id will never become this run's id, so retrying is pointless.
        if (body.testRunId === undefined) {
          return {
            ok: false,
            reason:
              `The API on port ${port} reports no testRunId.\n` +
              '  Either it is a leftover process started before this check existed, or\n' +
              '  TEST_RUN_ID was not passed through to the Worker.',
            remedy:
              `  Find it:  ss -lptn 'sport = :${port}'\n` +
              `  Stop it:  kill <pid>          # not pkill -f: it matches this shell too`,
          };
        }

        return {
          ok: false,
          reason:
            `The API on port ${port} is a leftover process from an earlier run.\n` +
            `  It reports run id ${JSON.stringify(body.testRunId)}, not this run's.`,
          remedy:
            `  Find it:  ss -lptn 'sport = :${port}'\n` +
            `  Stop it:  kill <pid>          # not pkill -f: it matches this shell too`,
        };
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    // Not yet listening.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  return {
    ok: false,
    reason: `The API did not become ready within ${Math.round(timeoutMs / 1000)}s. Last error: ${lastError}`,
    remedy:
      '  bun run db:migrate      # a missing schema makes every route fail\n' +
      '  bun run dev:api         # then start it, and watch its output',
  };
};

export const recordIdentity = (identity: RunIdentity): void => {
  currentRun = identity;
};

/** Where Playwright's per-run artefacts go. Outside the repo, and cleaned. */
export const evidenceDir = (): string =>
  process.env.E2E_EVIDENCE_DIR ?? join('/tmp', 'starter-evidence');
// apps/e2e/preflight.ts
//
// Proving this run's server is this run's server.
//
// The problem this exists to solve: a leftover server from an earlier command
// keeps its port. Playwright's `webServer` sees the port answer and — depending on
// version and reuse settings — either fails confusingly or, worse, *passes*, running
// every test against the stale process. That stale process has a stale D1 with a
// stale schema and stale seeded users. The suite then reports a product bug that is
// actually a leftover socket.
//
// The check is an identity assertion, not a liveness assertion. The app echoes a
// run id; global-setup sends a fresh one and requires it back. A server that
// cannot prove it is the one just started is not used.
//
// (`pkill -f` is deliberately not used anywhere: the pattern broad enough to match
// the dev server also matches the shell that launched it, which kills the caller.)

import { join } from 'node:path';
import { REPO_ROOT } from '../../scripts/src/shared/paths.ts';
import { appBaseUrl, APP_PORT as CONFIG_APP_PORT } from './playwright.config.ts';

export interface RunIdentity {
  /** Unique per Playwright invocation. */
  runId: string;
  appBaseUrl: string;
  appPort: number;
}

/**
 * The port and origin come from `playwright.config.ts` and are re-exported here.
 *
 * They used to be computed independently, with the literal `4183` on both sides.
 * That was one answer to one question written twice, and when the config moved to
 * a per-worktree port the two drifted: the Worker came up on 4267, the preflight
 * kept polling 4183, and the run failed with
 *
 *   The app did not become ready within 60s. Last error: fetch failed
 *
 * while the server under test was answering `GET / 200` the whole time. The
 * identity check is only meaningful if it looks where the server actually is, so
 * the value has exactly one home.
 *
 * Importing the config rather than inverting the dependency is deliberate:
 * `playwright.config.ts` must not import this module, or the two would be
 * circular. It does not — it only names this module in comments.
 */
export const APP_PORT = CONFIG_APP_PORT;

export { appBaseUrl };

let currentRun: RunIdentity | undefined;

export const currentIdentity = (): RunIdentity => {
  if (currentRun === undefined) {
    throw new Error('currentIdentity() called before global-setup completed.');
  }
  return currentRun;
};

export interface PreflightFailure {
  ok: false;
  reason: string;
  remedy: string;
}

export interface PreflightSuccess {
  ok: true;
  runId: string;
}

/**
 * Verify the app is this run's app.
 *
 * The app reports `testRunId` from its `TEST_RUN_ID` binding when one is set, so
 * this harness generates the id, puts it in the environment the app inherits, and
 * requires `/api/health` to report the same value.
 *
 * A stale listener answers `/api/health` just as readily as a correct one. A
 * readiness probe that only checks for a 200 will run a whole suite against the
 * wrong process — passing, and proving nothing.
 *
 * A *missing* id is also a failure, not something to pass through: it means
 * either a leftover server from before this feature, or a server started without
 * the binding. Both mean this suite would not be testing what it claims to.
 */
export const verifyAppIdentity = async (
  baseUrl: string = appBaseUrl,
  expectedRunId: string = currentIdentity().runId,
  timeoutMs = 60_000,
): Promise<PreflightSuccess | PreflightFailure> => {
  if (expectedRunId.length === 0) {
    throw new Error('verifyAppIdentity needs a run id to compare against.');
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
              `The server on port ${port} reports no testRunId.\n` +
              '  Either it is a leftover process started before this check existed, or\n' +
              '  TEST_RUN_ID was not passed through to the Worker.',
            remedy: findAndKill(port),
          };
        }

        return {
          ok: false,
          reason:
            `The server on port ${port} is a leftover process from an earlier run.\n` +
            `  It reports run id ${JSON.stringify(body.testRunId)}, not this run's.`,
          remedy: findAndKill(port),
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
    reason: `The app did not become ready within ${Math.round(timeoutMs / 1000)}s. Last error: ${lastError}`,
    remedy:
      '  bun run db:migrate      # a missing schema makes every route fail\n' +
      '  bun run dev:worker      # then start it, and watch its output',
  };
};

/**
 * How to stop a leftover listener.
 *
 * `kill <pid>` rather than `pkill -f`, and the comment says why: a pattern broad
 * enough to match this project's server also matches the shell that launched it,
 * so the pattern kill takes down the caller. The pid has to be looked up.
 */
const findAndKill = (port: string): string =>
  `  Find it:  ss -lptn 'sport = :${port}'\n` +
  `  Stop it:  kill <pid>          # not pkill -f: it matches this shell too`;

export const recordIdentity = (identity: RunIdentity): void => {
  currentRun = identity;
};

/** Where Playwright's per-run artefacts go. Outside the repo, and cleaned. */
export const evidenceDir = (): string =>
  process.env.E2E_EVIDENCE_DIR ?? join(REPO_ROOT, '.wrangler', 'evidence');

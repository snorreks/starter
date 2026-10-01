// scripts/tests/contracts_cli.test.ts
//
// The contract command's resume path, driven through `main`.
//
// Two defects in this area shared one shape: a path that reached `runContract`
// without checking what it was about to run. Both are proven here against real
// persisted manifests, not against a hand-built call.
//
//   1. `run` without `--dry-run` refused only when *no* manifest existed. So
//      `--resume` on a real run walked straight past the check and handed the
//      **dry adapter** a real manifest: every un-succeeded stage was saved as
//      `succeeded` having executed nothing. The run then blocked on missing
//      verification evidence and exited 1 rather than 3 — and the persisted
//      `succeeded` statuses meant a future real adapter would skip those stages as
//      proven, which is the original defect of this whole area.
//   2. `sourceRevision` was written only when a manifest was created, so a resumed
//      run kept the revision it was born at. Acceptance compares verification
//      evidence against `sourceRevision`, so evidence gathered from an older tree
//      was accepted for a newer one.
//
// Fixtures are manifests written into the local runs directory and removed again.
// That directory is gitignored runtime state, and writing there is the only way to
// reach the resume path — `main` has no runs-directory seam. The contract document
// itself is a temp file, so nothing is asserted against the repository.
//
// Exit codes come from the shared `EXIT`: the command's local codes are the same
// numbers (`blocked` is the command's name for `failed`, `adapterUnavailable` for
// `unavailable`), so the shared table is the honest thing to assert against.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listRuns, loadManifest, main, RUNS_DIR, saveManifest } from '../src/commands/contracts.ts';
import { EXIT } from '../src/shared/command.ts';
import { createManifest, type RunManifest, type StageEvidence } from '../src/contracts/runner.ts';

const CONTRACT_ID = 'C-900';
// A run's deadline is `startedAt + maxRunMs`, so a fixture stamped in the past is
// already out of budget and every resume of it blocks before doing anything. A real
// manifest was created moments ago; so is this one.
const T0 = Date.now();

const runsBefore = listRuns().length;
const cleanups: string[] = [];
const writtenRunIds: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  // Always, rather than at the end of each test: a failed assertion must not leave
  // a fixture behind for `contract status` to report as a real run.
  for (const runId of writtenRunIds.splice(0)) {
    rmSync(join(RUNS_DIR, `${runId}.json`), { force: true });
  }
});

/** A contract document `parseContract` can read, in a temp directory. */
const contractFile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'contract-cli-'));
  cleanups.push(dir);
  const path = join(dir, 'C-900-fixture.md');
  writeFileSync(path, `# ${CONTRACT_ID} — Fixture\n\n**Type:** standard\n`);
  return path;
};

const revision = (): string => {
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: process.cwd() });
  return head.stdout.toString().trim();
};

const evidenceFor = (sourceRevision: string): StageEvidence => ({
  kind: 'verification',
  command: 'bun run test:all',
  exitCode: 0,
  sourceRevision,
  recordedAt: T0,
});

const fixtureRunId = (): string => `run-fixture-${Math.random().toString(36).slice(2, 10)}`;

/** Persist a manifest the resume path will find. */
const persist = (manifest: RunManifest): string => {
  writtenRunIds.push(manifest.runId);
  saveManifest(manifest);
  return manifest.runId;
};

/**
 * A manifest as a previous invocation left it: `implement` failed, and the run is
 * blocked.
 *
 * `verify` is marked succeeded with evidence, which no blocked run would really
 * carry. That is the point: if a resume lets it survive a revision change, the run
 * can be accepted on evidence from a tree it never ran against.
 */
const blockedRun = (sourceRevision: string, dryRun: boolean): RunManifest => {
  const base = createManifest(CONTRACT_ID, 'standard', T0, {
    runId: fixtureRunId(),
    dryRun,
    sourceRevision,
  });
  return {
    ...base,
    state: 'blocked',
    invocations: 1,
    stages: {
      ...base.stages,
      implement: { stage: 'implement', status: 'failed', attempts: 2, error: 'broken' },
      verify: {
        stage: 'verify',
        status: 'succeeded',
        attempts: 1,
        evidence: evidenceFor(sourceRevision),
      },
    },
  };
};

const quiet = async (body: () => Promise<number>): Promise<number> => {
  const original = { out: process.stdout.write, err: process.stderr.write };
  // The command prints the manifest it is about to run. Useful to a human, noise
  // here, and suppressing it must not suppress what it returns.
  process.stdout.write = () => true;
  process.stderr.write = () => true;
  try {
    return await body();
  } finally {
    process.stdout.write = original.out;
    process.stderr.write = original.err;
  }
};

describe('a real run has no adapter, whether it is new or resumed', () => {
  test('a new non-dry run refuses and writes no manifest', async () => {
    const code = await quiet(() => main(['run', contractFile()]));

    expect(code).toBe(EXIT.unavailable);
    // The refusal leaves no run behind: a manifest nobody executed is exactly the
    // kind of state that reads as progress later.
    expect(listRuns()).toHaveLength(runsBefore);
  });

  test('a resumed real run refuses instead of running the dry adapter', async () => {
    // THE DEFECT. This used to return `accepted` having executed nothing.
    const runId = persist(blockedRun(revision(), false));
    const before = loadManifest(runId);

    const code = await quiet(() => main(['run', contractFile(), '--resume', runId]));

    expect(code).toBe(EXIT.unavailable);
    // Untouched: no stage status was rewritten by an adapter that does no work, and
    // the invocation count did not move either.
    expect(loadManifest(runId)).toEqual(before);
    expect(loadManifest(runId)?.stages.implement?.status).toBe('failed');
  });
});

describe('resume mode must match the manifest', () => {
  test('a real run resumed with --dry-run is refused', async () => {
    // The other direction of the same defect: the dry adapter over a real manifest
    // records its stages as succeeded without performing them.
    const runId = persist(blockedRun(revision(), false));
    const before = loadManifest(runId);

    const code = await quiet(() => main(['run', contractFile(), '--dry-run', '--resume', runId]));

    expect(code).toBe(EXIT.usage);
    expect(loadManifest(runId)).toEqual(before);
  });

  test('a dry run resumed without --dry-run is refused', async () => {
    const runId = persist(blockedRun(revision(), true));
    const before = loadManifest(runId);

    const code = await quiet(() => main(['run', contractFile(), '--resume', runId]));

    expect(code).toBe(EXIT.usage);
    expect(loadManifest(runId)).toEqual(before);
  });
});

describe('a resumed run binds to the current source revision', () => {
  test('a moved revision invalidates the previous verification', async () => {
    const stale = revision().replace(/^./, (first) => (first === '0' ? '1' : '0'));
    expect(stale).not.toBe(revision());
    const runId = persist(blockedRun(stale, true));

    const code = await quiet(() => main(['run', contractFile(), '--dry-run', '--resume', runId]));
    expect(code).toBe(EXIT.ok);

    const after = loadManifest(runId);
    expect(after?.sourceRevision).toBe(revision());
    // Verification evidence gathered on the old tree says nothing about this one,
    // so it is dropped rather than carried forward and accepted.
    expect(after?.stages.verify?.evidence).toBeUndefined();
  });

  test('an unchanged revision keeps the verification it has', async () => {
    // The other half: a resume that threw away a passing verification would make
    // every resume re-verify, which is how evidence stops meaning anything.
    const runId = persist(blockedRun(revision(), true));

    const code = await quiet(() => main(['run', contractFile(), '--dry-run', '--resume', runId]));
    expect(code).toBe(EXIT.ok);

    const after = loadManifest(runId);
    expect(after?.sourceRevision).toBe(revision());
    expect(after?.stages.verify?.evidence?.sourceRevision).toBe(revision());
    expect(after?.stages.verify?.attempts).toBe(1);
  });
});

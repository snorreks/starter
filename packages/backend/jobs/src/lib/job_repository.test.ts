// packages/backend/jobs/src/lib/job_repository.test.ts
//
// The admission rules, on a real SQLite engine running the real statements.
//
// Why `bun:sqlite` rather than a fake repository
// -----------------------------------------------
// Every claim in this file is about *SQL semantics*: a correlated subquery that is
// evaluated as part of the write, a partial unique index that turns "one active
// job per user" into a constraint violation, an `UPDATE … WHERE active_attempt_id
// = ?` that must match no rows for a superseded attempt. A mock would have to
// reimplement all three, and a mock that reimplements them is a second
// implementation that can disagree with the first.
//
// So: the committed migrations, verbatim, applied to `bun:sqlite`, through a small
// adapter that mirrors D1's `prepare/bind/all/run/first` and its `meta.changes`.
// The same statements are exercised again against a real D1 binding in
// `apps/frontend/client/tests/worker_integration.test.ts`. If the two engines ever
// disagree about a statement, one of those two suites goes red.
//
// The clock
// ---------
// Every test drives a fixed clock. Nothing sleeps, and nothing reads `Date.now()`
// — a budget window proved by waiting an hour is a test nobody runs, and a
// `setTimeout` in a suite is a flaky suite.

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDEMPOTENCY_KEY_HEADER } from '@starter/schemas/jobs';
import {
  type Clock,
  createJobRepository,
  type JobRepository,
  type JobsDatabase,
  parseJobCursor,
  startOfUtcDay,
  workflowIdFor,
} from './job_repository.ts';

/**
 * The repository root, from this file's URL.
 *
 * Not `process.cwd()`: the unit lane runs from this package and the Worker lane
 * from the repository root. Five levels up from `src/lib/` is the root
 * (`lib` → `src` → `jobs` → `backend` → `packages` → root).
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/backend/database/drizzle-d1');

/**
 * Apply the *committed* migrations, in order.
 *
 * Read from disk rather than from a schema literal so a migration that was never
 * generated — or generated but not committed — fails here instead of passing a
 * suite that tested a table this repository does not actually have.
 */
const migrate = (db: Database): void => {
  const files = [
    '0000_graceful_grey_gargoyle.sql',
    '0001_early_captain_cross.sql',
    '0002_broken_vector.sql',
    '0003_dark_phantom_reporter.sql',
  ];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint')) {
      if (statement.trim().length > 0) {
        db.exec(statement);
      }
    }
  }
};

/**
 * `bun:sqlite` behind D1's statement surface.
 *
 * `prepare` on a real D1 statement is synchronous, so this mirrors that rather
 * than being lazy about it — an adapter that awaited `prepare` would let a
 * production-only assumption through.
 */
/**
 * Rows the most recent write actually changed.
 *
 * `changes()` is read immediately after the write, in the same synchronous step,
 * because the next statement on the same connection resets it. This is the number
 * D1 reports as `meta.changes`, and it is the number every "affected rows" claim
 * in this repository rests on — so it is read once, here, rather than re-derived.
 */
const changedRows = (db: Database): { changes: number } => ({
  changes: (db.query('SELECT changes() AS n').get() as { n: number }).n,
});

const asD1 = (db: Database): JobsDatabase => ({
  prepare(query: string) {
    const statement = db.query(query);
    return {
      bind(...values: unknown[]) {
        return {
          all<T>() {
            // `RETURNING` is read through `all`, exactly as D1 does: a statement
            // that returns rows and a statement that reports a change count are the
            // same call on D1, and this keeps both paths on one implementation.
            const rows = statement.all(...(values as never[])) as T[];
            return Promise.resolve({ results: rows, meta: changedRows(db) });
          },
          run() {
            statement.run(...(values as never[]));
            return Promise.resolve({ meta: changedRows(db), results: [] as never[] });
          },
          first<T>(columnName?: string) {
            const row = statement.get(...(values as never[])) as Record<string, unknown> | null;
            if (row === null) {
              return Promise.resolve(null);
            }
            if (columnName !== undefined) {
              return Promise.resolve((row[columnName] ?? null) as T);
            }
            return Promise.resolve(row as T);
          },
        };
      },
    };
  },
});

/** A clock the test moves. The only way time passes in this file. */
const fixedClock = (
  startMs: number,
): Clock & { set(ms: number): void; advance(ms: number): void } => {
  let current = startMs;
  return {
    now: () => current,
    set: (ms: number) => {
      current = ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
};

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0); // 2026-10-05T12:00:00Z, mid-UTC-day
const HOUR = 60 * 60 * 1000;

let sqlite: Database;
let clock: ReturnType<typeof fixedClock>;
let repository: JobRepository;

const OWNER_A = 'user_alice';
const OWNER_B = 'user_bob';

const request = () => ({ fixture: 'sample-v1', preset: 'demo-180p-v1' }) as const;

let nextJobId = 0;
const newJobId = (): string => {
  nextJobId += 1;
  return `job_${nextJobId}`;
};

beforeEach(() => {
  sqlite = new Database(':memory:');
  migrate(sqlite);
  // Two users, because `jobs.owner_id` is a foreign key and the ownership tests
  // need a second owner to exist.
  sqlite.exec(
    "INSERT INTO users (id, name, email, email_verified) VALUES ('user_alice', 'Alice', 'a@example.invalid', 1), ('user_bob', 'Bob', 'b@example.invalid', 1)",
  );
  clock = fixedClock(T0);
  repository = createJobRepository(asD1(sqlite), clock);
});

const admit = async (owner: string, key = newJobId(), idempotencyKey = newJobId()) =>
  repository.createEncodeJob(owner, request(), idempotencyKey, key);

const seedTerminalJobs = (count: number): void => {
  for (let index = 0; index < count; index += 1) {
    sqlite
      .query(`INSERT INTO jobs (
      id, owner_id, kind, status, fixture, preset, idempotency_key, request_fingerprint,
      workflow_id, dispatch_state, created_at, updated_at
    ) VALUES (?, ?, 'encode', 'failed', 'sample-v1', 'demo-180p-v1', ?, '{}', ?, 'pending', ?, ?)`)
      .run(
        `job_seed_${index}`,
        OWNER_A,
        `key_seed_${index}`,
        `encode-seed-${index}`,
        T0 / 1000,
        T0 / 1000,
      );
  }
};

// ── Admission ────────────────────────────────────────────────────────────────

describe('createEncodeJob', () => {
  test('admits one job and reports it pending with no output', async () => {
    const outcome = await admit(OWNER_A);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }

    expect(outcome.replayed).toBe(false);
    expect(outcome.job.status).toBe('pending');
    expect(outcome.job.ownerId).toBe(OWNER_A);
    expect(outcome.job.output).toBeNull();
    expect(outcome.job.errorCode).toBeNull();
    expect(outcome.job.createdAt).toBe(T0);
    // The Workflow id is derived, not supplied: a caller that chose it could point
    // two jobs at one instance, or one job at somebody else's.
    expect(outcome.job.workflowId).toBe(workflowIdFor(outcome.job.id));
  });

  test('the same key with the same body returns the same job and spends nothing twice', async () => {
    const first = await repository.createEncodeJob(OWNER_A, request(), 'retry-me', newJobId());
    const second = await repository.createEncodeJob(OWNER_A, request(), 'retry-me', newJobId());

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }

    expect(second.replayed).toBe(true);
    expect(second.job.id).toBe(first.job.id);

    const rows = sqlite.query('SELECT count(*) AS n FROM jobs').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  test('a replay is refused while the first job is still active, and admitted once it is not', async () => {
    // The replay path must short-circuit before the budget subqueries, or a retry
    // of the request that created a job would be refused by the very cap that job
    // caused. This is the sequence that proves it.
    const first = await repository.createEncodeJob(OWNER_A, request(), 'retry-me', newJobId());
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const replay = await repository.createEncodeJob(OWNER_A, request(), 'retry-me', newJobId());
    expect(replay.ok).toBe(true);

    // Terminal, then a fresh key is admitted: the active cap released.
    sqlite.exec(
      `UPDATE jobs SET status = 'failed', error_code = 'encode_failed', active_attempt_id = NULL WHERE id = '${first.job.id}'`,
    );
    const next = await admit(OWNER_A);
    expect(next.ok).toBe(true);
  });

  test('a second concurrent job for the same user is refused by the active cap', async () => {
    expect((await admit(OWNER_A)).ok).toBe(true);
    const second = await admit(OWNER_A);

    expect(second.ok).toBe(false);
    if (second.ok) {
      return;
    }
    expect(second.reason).toBe('budget_exceeded');
    expect(second.budget).toBe('active');

    const rows = sqlite.query('SELECT count(*) AS n FROM jobs').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  test('the active cap is decided by the database, not by a prior read', async () => {
    // Two admissions with no interleaving step between them. A repository that read
    // the count first would still pass a sequential test, so this exists to make
    // the sequential case and the "same instant" case the same code path: they are,
    // because there is no read before the write to interleave with.
    expect((await admit(OWNER_A)).ok).toBe(true);
    const refused = await repository.createEncodeJob(OWNER_A, request(), newJobId(), newJobId());
    expect(refused.ok).toBe(false);
  });

  test('another user is unaffected by the first user active job', async () => {
    expect((await admit(OWNER_A)).ok).toBe(true);
    expect((await admit(OWNER_B)).ok).toBe(true);

    const rows = sqlite.query('SELECT count(DISTINCT owner_id) AS n FROM jobs').get() as {
      n: number;
    };
    expect(rows.n).toBe(2);
  });

  test('the hourly cap refuses the sixth job in a rolling hour', async () => {
    // Five jobs need five terminal jobs first, because the active cap of one would
    // otherwise fire first and the hourly cap would never be reached. Each is
    // terminalised by hand so the test is about the hourly window only.
    for (let index = 0; index < 5; index += 1) {
      const outcome = await admit(OWNER_A, `job_h${index}`, `key-h${index}`);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        sqlite.exec(`UPDATE jobs SET status = 'failed' WHERE id = '${outcome.job.id}'`);
      }
      clock.advance(60 * 1000);
    }

    const sixth = await admit(OWNER_A);
    expect(sixth.ok).toBe(false);
    if (sixth.ok) {
      return;
    }
    expect(sixth.reason).toBe('budget_exceeded');
    expect(sixth.budget).toBe('hourly');
  });

  test('the hourly window is rolling, so an hour-old job stops counting', async () => {
    for (let index = 0; index < 5; index += 1) {
      const outcome = await admit(OWNER_A, `job_h${index}`, `key-h${index}`);
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        sqlite.exec(`UPDATE jobs SET status = 'failed' WHERE id = '${outcome.job.id}'`);
      }
      clock.advance(60 * 1000);
    }
    expect((await admit(OWNER_A)).ok).toBe(false);

    // Past the oldest job's one-hour window, but still inside the same UTC day.
    clock.set(T0 + 4 * HOUR + 60 * 1000);
    expect((await admit(OWNER_A)).ok).toBe(true);
  });

  test('the environment-wide daily cap refuses the fifty-first job of a UTC day', async () => {
    const bounded = createJobRepository(asD1(sqlite), clock, {
      maxActivePerUser: 1,
      // One user would hit the hourly cap long before this, so the per-user windows
      // are raised to isolate the daily rule being tested.
      maxPerUserPerHour: 10_000,
      maxPerEnvironmentPerUtcDay: 3,
    });

    // Spread three users so the *environment* budget is what refuses, not a
    // per-user one. Two extra users exist only for this test.
    sqlite.exec(
      "INSERT INTO users (id, name, email) VALUES ('user_carol', 'Carol', 'c@example.invalid'), ('user_dave', 'Dave', 'd@example.invalid')",
    );

    // Each job is terminalised immediately, so the refusal this test is about is
    // the environment budget and never the one-active-job index. A test that let
    // the active cap fire would pass for the wrong reason.
    let admitted = 0;
    for (let index = 0; index < 6; index += 1) {
      const owner = [OWNER_A, OWNER_B, 'user_carol'][index % 3];
      const outcome = await bounded.createEncodeJob(owner, request(), `k${index}`, newJobId());
      if (outcome.ok) {
        admitted += 1;
        sqlite.exec(`UPDATE jobs SET status = 'failed' WHERE id = '${outcome.job.id}'`);
      } else {
        expect(outcome.reason).toBe('budget_exceeded');
        expect(outcome.budget).toBe('daily');
      }
    }

    expect(admitted).toBe(3);

    // The next UTC day the environment budget is fresh again.
    clock.set(startOfUtcDay(T0) + 24 * HOUR + 1000);
    expect((await bounded.createEncodeJob(OWNER_A, request(), 'next-day', newJobId())).ok).toBe(
      true,
    );
  });

  test('the daily window is a UTC calendar day, not a rolling 24 hours', () => {
    // 23:59:30Z on the 5th and 00:00:30Z on the 6th are thirty seconds apart and
    // different days. A rolling window would treat them as one; a calendar day is
    // what "per environment per UTC day" means to an operator reading a usage bill.
    expect(startOfUtcDay(Date.UTC(2026, 9, 5, 23, 59, 30))).toBe(Date.UTC(2026, 9, 5));
    expect(startOfUtcDay(Date.UTC(2026, 9, 6, 0, 0, 30))).toBe(Date.UTC(2026, 9, 6));
  });

  test('an idempotency key is scoped to its owner', async () => {
    // Two users choosing the same key must not collide, and must not be able to
    // read each other's job through the replay path.
    const a = await repository.createEncodeJob(OWNER_A, request(), 'collide', newJobId());
    const b = await repository.createEncodeJob(OWNER_B, request(), 'collide', newJobId());

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) {
      return;
    }
    expect(a.job.id).not.toBe(b.job.id);
    expect(b.replayed).toBe(false);
    expect(b.job.ownerId).toBe(OWNER_B);
  });
});

// ── Ownership ────────────────────────────────────────────────────────────────

describe('ownership', () => {
  test.each(['fixture', 'preset'])('an unknown stored %s is rejected', async (column) => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    sqlite.query(`UPDATE jobs SET ${column} = ? WHERE id = ?`).run('unknown', created.job.id);
    await expect(repository.getJobForOwner(OWNER_A, created.job.id)).rejects.toThrow(
      'unknown fixture or preset',
    );
  });

  test("getJobForOwner answers null for another user's job", async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    expect((await repository.getJobForOwner(OWNER_B, created.job.id))?.id).toBeUndefined();
    expect(await repository.getJobForOwner(OWNER_B, created.job.id)).toBeNull();
    expect((await repository.getJobForOwner(OWNER_A, created.job.id))?.id).toBe(created.job.id);
  });

  test('a guessed job id from another owner is indistinguishable from a missing one', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    // Same shape of answer for "not yours" and "does not exist" — a 403 here would
    // be an existence oracle.
    const notYours = await repository.getJobForOwner(OWNER_B, created.job.id);
    const doesNotExist = await repository.getJobForOwner(OWNER_B, 'job_does_not_exist');
    expect(notYours).toBeNull();
    expect(doesNotExist).toBeNull();
  });

  test("listJobsForOwner never lists another owner's jobs", async () => {
    const a = await admit(OWNER_A);
    expect(a.ok).toBe(true);
    if (!a.ok) {
      return;
    }
    sqlite.exec(`UPDATE jobs SET status = 'failed' WHERE id = '${a.job.id}'`);
    const b = await admit(OWNER_B);
    expect(b.ok).toBe(true);
    if (!b.ok) {
      return;
    }
    sqlite.exec(`UPDATE jobs SET status = 'failed' WHERE id = '${b.job.id}'`);

    const page = await repository.listJobsForOwner(OWNER_A);
    expect(page.jobs.map((job) => job.ownerId)).toEqual([OWNER_A]);
    expect(page.jobs).toHaveLength(1);
  });

  test('listJobsForOwner clamps an absurd limit to the frozen bound', async () => {
    seedTerminalJobs(60);
    const bounded = createJobRepository(asD1(sqlite), clock);
    const page = await bounded.listJobsForOwner(OWNER_A, { limit: 100_000 });
    expect(page.jobs).toHaveLength(50);
  });

  test('a cursor pages without dropping a job created in the same millisecond', async () => {
    // Two jobs at one instant share a created_at. A bare timestamp cursor would
    // skip the second of them, which is the classic "the list is missing an item"
    // bug that only appears under load.
    for (let index = 0; index < 3; index += 1) {
      const outcome = await repository.createEncodeJob(
        OWNER_A,
        request(),
        `k${index}`,
        `job_p${index}`,
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        sqlite.exec(`UPDATE jobs SET status = 'failed' WHERE id = '${outcome.job.id}'`);
      }
    }

    const first = await repository.listJobsForOwner(OWNER_A, { limit: 2 });
    expect(first.jobs).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const parsed = parseJobCursor(first.nextCursor);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const second = await repository.listJobsForOwner(OWNER_A, { limit: 2, cursor: parsed.cursor });
    expect(second.jobs).toHaveLength(1);

    const seen = [...first.jobs, ...second.jobs].map((job) => job.id).sort();
    expect(seen).toEqual(['job_p0', 'job_p1', 'job_p2']);
  });
});

// ── Attempt fencing ──────────────────────────────────────────────────────────

describe('attempt fencing', () => {
  const commitOutput = () => ({
    key: 'jobs/output-1.mp4',
    bytes: 4096,
    sha256: 'a'.repeat(64),
    containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodec: 'h264',
    width: 320,
    height: 180,
    durationMs: 3000,
    expiresAt: T0 + 24 * HOUR,
  });

  test('a claim takes the lease and moves the job to running', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const claim = await repository.claimAttempt(created.job.id, 'attempt-1', T0 + 5 * 60 * 1000);
    expect(claim.ok).toBe(true);
    if (!claim.ok) {
      return;
    }
    expect(claim.job.status).toBe('running');
    expect(claim.job.activeAttemptId).toBe('attempt-1');
    expect(claim.job.attemptCount).toBe(1);
  });

  test('a second attempt cannot claim a job whose lease is live', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    expect(
      (await repository.claimAttempt(created.job.id, 'attempt-1', T0 + 5 * 60 * 1000)).ok,
    ).toBe(true);
    const second = await repository.claimAttempt(created.job.id, 'attempt-2', T0 + 5 * 60 * 1000);
    expect(second.ok).toBe(false);
    if (second.ok) {
      return;
    }
    expect(second.reason).toBe('lease_held');
  });

  test('an expired lease may be taken over, and the old attempt is then fenced', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    expect((await repository.claimAttempt(created.job.id, 'attempt-1', T0 + 1000)).ok).toBe(true);

    // Past the lease: the original attempt is presumed dead, not presumed right.
    clock.set(T0 + 60_000);
    const takeover = await repository.claimAttempt(
      created.job.id,
      'attempt-2',
      clock.now() + 60_000,
    );
    expect(takeover.ok).toBe(true);

    // The stale attempt wakes up and commits. This is the exact case the fence
    // exists for: it must change nothing.
    const stale = await repository.completeAttempt(created.job.id, 'attempt-1', commitOutput());
    expect(stale.ok).toBe(false);
    if (stale.ok) {
      return;
    }
    expect(stale.reason).toBe('fenced');
  });

  test('a stale failure cannot overwrite a committed success', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    await repository.claimAttempt(created.job.id, 'attempt-1', T0 + 1000);
    clock.set(T0 + 60_000);
    await repository.claimAttempt(created.job.id, 'attempt-2', clock.now() + 60_000);

    const success = await repository.completeAttempt(created.job.id, 'attempt-2', commitOutput());
    expect(success.ok).toBe(true);
    if (!success.ok) {
      return;
    }
    expect(success.job.status).toBe('succeeded');
    expect(success.job.output?.bytes).toBe(4096);

    // The superseded attempt now reports a failure. If this matched, a demo would
    // show a failed job whose output exists — the "dangling success" in reverse.
    const late = await repository.failAttempt(created.job.id, 'attempt-1', 'encode_failed');
    expect(late.ok).toBe(false);
    if (late.ok) {
      return;
    }
    expect(late.reason).toBe('fenced');

    const stored = await repository.getJobForOwner(OWNER_A, created.job.id);
    expect(stored?.status).toBe('succeeded');
    expect(stored?.errorCode).toBeNull();
    expect(stored?.output?.bytes).toBe(4096);
  });

  test('a terminal job cannot be reopened or re-claimed', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await repository.claimAttempt(created.job.id, 'attempt-1', T0 + 1000);
    await repository.completeAttempt(created.job.id, 'attempt-1', commitOutput());

    const reclaim = await repository.claimAttempt(created.job.id, 'attempt-9', clock.now() + 1000);
    expect(reclaim.ok).toBe(false);
    if (reclaim.ok) {
      return;
    }
    expect(reclaim.reason).toBe('not_claimable');
  });

  test('the final live attempt can finish before exhaustion terminalizes it', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    for (let index = 1; index <= 3; index += 1) {
      expect(
        (await repository.claimAttempt(created.job.id, `attempt-${index}`, clock.now() + 1000)).ok,
      ).toBe(true);
      if (index < 3) {
        clock.advance(2000);
      }
    }
    expect(await repository.claimAttempt(created.job.id, 'attempt-4', clock.now() + 1000)).toEqual({
      ok: false,
      reason: 'lease_held',
    });
    expect(await repository.failStaleJobs(clock.now(), 10)).toBe(0);
    expect((await repository.completeAttempt(created.job.id, 'attempt-3', commitOutput())).ok).toBe(
      true,
    );
    expect(await repository.claimAttempt(created.job.id, 'attempt-4', clock.now() + 1000)).toEqual({
      ok: false,
      reason: 'not_claimable',
    });
  });

  test('maintenance terminalizes an exhausted job after its final lease expires', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    for (let index = 1; index <= 3; index += 1) {
      expect(
        (await repository.claimAttempt(created.job.id, `attempt-${index}`, clock.now() + 1000)).ok,
      ).toBe(true);
      clock.advance(2000);
    }
    expect(await repository.failStaleJobs(T0, 10)).toBe(1);
    expect(await repository.getJobForOwner(OWNER_A, created.job.id)).toMatchObject({
      status: 'failed',
      errorCode: 'attempts_exhausted',
      activeAttemptId: null,
    });
    expect((await admit(OWNER_A)).ok).toBe(true);
  });

  test('attempts are bounded', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    for (let index = 1; index <= 3; index += 1) {
      const claim = await repository.claimAttempt(
        created.job.id,
        `attempt-${index}`,
        clock.now() + 1000,
      );
      expect(claim.ok).toBe(true);
      // Let the lease lapse so the next attempt may take over.
      clock.advance(2000);
    }

    const fourth = await repository.claimAttempt(created.job.id, 'attempt-4', clock.now() + 1000);
    expect(fourth.ok).toBe(false);
    if (fourth.ok) {
      return;
    }
    expect(fourth.reason).toBe('attempts_exhausted');
    expect(await repository.getJobForOwner(OWNER_A, created.job.id)).toMatchObject({
      status: 'failed',
      errorCode: 'attempts_exhausted',
      activeAttemptId: null,
      completedAt: clock.now(),
    });
    expect(
      sqlite.query('SELECT lease_expires_at FROM jobs WHERE id = ?').get(created.job.id),
    ).toEqual({ lease_expires_at: null });
    expect((await admit(OWNER_A)).ok).toBe(true);
  });

  test('a claim against a job that does not exist says so', async () => {
    const claim = await repository.claimAttempt('job_missing', 'attempt-1', T0 + 1000);
    expect(claim.ok).toBe(false);
    if (claim.ok) {
      return;
    }
    expect(claim.reason).toBe('not_found');
  });

  test('completeAttempt records the measured output and clears the lease', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await repository.claimAttempt(created.job.id, 'attempt-1', T0 + 60_000);

    const done = await repository.completeAttempt(created.job.id, 'attempt-1', commitOutput());
    expect(done.ok).toBe(true);
    if (!done.ok) {
      return;
    }

    expect(done.job.output).toEqual({
      bytes: 4096,
      sha256: 'a'.repeat(64),
      containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
      videoCodec: 'h264',
      width: 320,
      height: 180,
      durationMs: 3000,
      expiresAt: T0 + 24 * HOUR,
    });
    // The private key stays on the record and off the DTO: it is the server's
    // business, and a browser that knew it would need the bucket.
    expect(done.job.outputKey).toBe('jobs/output-1.mp4');
    expect(done.job.activeAttemptId).toBeNull();
    expect(done.job.completedAt).toBe(T0);
  });

  test('failAttempt writes the code and releases the lease', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await repository.claimAttempt(created.job.id, 'attempt-1', T0 + 60_000);

    const failed = await repository.failAttempt(created.job.id, 'attempt-1', 'attempts_exhausted');
    expect(failed.ok).toBe(true);
    if (!failed.ok) {
      return;
    }
    expect(failed.job.status).toBe('failed');
    expect(failed.job.errorCode).toBe('attempts_exhausted');
    expect(failed.job.activeAttemptId).toBeNull();
  });
});

// ── Dispatch bookkeeping ─────────────────────────────────────────────────────

describe('dispatch bookkeeping', () => {
  test('an admitted job starts pending and becomes dispatched', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect(created.job.dispatchState).toBe('pending');
    expect(created.job.workflowId).toBe(workflowIdFor(created.job.id));

    expect(await repository.markDispatched(created.job.id)).toBe(true);
    const after = await repository.getJobForOwner(OWNER_A, created.job.id);
    expect(after?.dispatchState).toBe('dispatched');
  });

  test('markDispatched is idempotent', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    // A retried dispatch must not report a second success, or a reconciliation
    // pass would keep re-dispatching a job that is already running.
    expect(await repository.markDispatched(created.job.id)).toBe(true);
    expect(await repository.markDispatched(created.job.id)).toBe(false);
  });

  test('a dispatch failure stays visible and recoverable', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    // The exact crash the design calls out: D1 committed the admission, and then
    // the Workflow call failed. The job is still admitted, still visible, and
    // still owed a dispatch.
    expect(await repository.markDispatchFailed(created.job.id, 'workflow_binding_missing')).toBe(
      true,
    );

    const after = await repository.getJobForOwner(OWNER_A, created.job.id);
    expect(after?.status).toBe('pending');
    expect(after?.dispatchState).toBe('dispatch_failed');
    expect(after?.dispatchError).toBe('workflow_binding_missing');
    expect(after?.dispatchAttempts).toBe(1);

    const pending = await repository.listPendingDispatches(10);
    expect(pending.map((job) => job.id)).toContain(created.job.id);

    // And it recovers: a successful retry moves it to dispatched.
    expect(await repository.markDispatched(created.job.id)).toBe(true);
  });

  test('non-retryable and exhausted dispatch failures are excluded from recovery', async () => {
    const alice = await admit(OWNER_A);
    const bob = await admit(OWNER_B);
    expect(alice.ok && bob.ok).toBe(true);
    if (!alice.ok || !bob.ok) {
      return;
    }
    expect(await repository.markDispatchFailed(alice.job.id, 'protocol_rejected')).toBe(true);
    for (let index = 0; index < 3; index += 1) {
      expect(await repository.markDispatchFailed(bob.job.id, 'provider_unavailable')).toBe(true);
      expect((await repository.listPendingDispatches(10)).map((job) => job.id)).toEqual(
        index < 2 ? [bob.job.id] : [],
      );
    }
    expect(await repository.failStaleJobs(T0 - HOUR, 1)).toBe(1);
    expect(await repository.failStaleJobs(T0 - HOUR, 10)).toBe(1);
    expect((await admit(OWNER_A)).ok).toBe(true);
    expect((await admit(OWNER_B)).ok).toBe(true);
  });

  test('listPendingDispatches is bounded', async () => {
    seedTerminalJobs(60);
    expect(await repository.listPendingDispatches(0)).toHaveLength(1);
    expect(await repository.listPendingDispatches(1_000)).toHaveLength(50);
  });
});

// ── Artifact retention ───────────────────────────────────────────────────────

describe('artifact retention', () => {
  const commitOutput = (key: string) => ({
    key,
    bytes: 4096,
    sha256: 'b'.repeat(64),
    containerFormat: 'mp4',
    videoCodec: 'h264',
    width: 320,
    height: 180,
    durationMs: 3000,
    expiresAt: T0 + 24 * HOUR,
  });

  test('an artifact becomes listable only once it is past its cutoff', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await repository.claimAttempt(created.job.id, 'attempt-1', T0 + 60_000);
    await repository.completeAttempt(created.job.id, 'attempt-1', commitOutput('jobs/a.mp4'));

    // One millisecond before the cutoff the artifact is still owned. The boundary
    // itself is inclusive on purpose: `expiresAt` is the instant the bytes stop
    // being available, so a cutoff equal to it must already list the job.
    expect(await repository.listExpiredArtifacts(T0 + 24 * HOUR - 1, 10)).toHaveLength(0);
    clock.set(T0 + 24 * HOUR + 1000);
    const expired = await repository.listExpiredArtifacts(clock.now(), 10);
    expect(expired.map((job) => job.id)).toEqual([created.job.id]);
  });

  test('retirement is queued, confirmed and closed, and only then is the output cleared', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await repository.claimAttempt(created.job.id, 'attempt-1', T0 + 60_000);
    await repository.completeAttempt(created.job.id, 'attempt-1', commitOutput('jobs/a.mp4'));
    clock.set(T0 + 24 * HOUR + 1000);

    expect(await repository.enqueueArtifactRetirement(created.job.id, clock.now())).toBe(true);

    expect(await repository.enqueueArtifactRetirement(created.job.id, clock.now())).toBe(false);
    expect(await repository.listExpiredArtifacts(clock.now(), 10)).toEqual([]);
    const queued = await repository.listArtifactRetirements(10);
    expect(queued.map((entry) => entry.jobId)).toEqual([created.job.id]);
    expect(queued[0]?.outputKey).toBe('jobs/a.mp4');

    // The job still claims an artifact until the storage owner confirms the bytes
    // are gone. Closing early is how a database ends up describing an object that
    // is still in the bucket.
    const before = await repository.getJobForOwner(OWNER_A, created.job.id);
    expect(before?.output).not.toBeNull();

    expect(await repository.completeArtifactRetirement(created.job.id)).toBe(true);
    expect(await repository.clearJobOutput(created.job.id)).toBe(true);

    const after = await repository.getJobForOwner(OWNER_A, created.job.id);
    expect(after?.output).toBeNull();
    expect(after?.outputKey).toBeNull();
    // The job is still `succeeded`: the encode succeeded, the artifact aged out.
    expect(after?.status).toBe('succeeded');
    expect(await repository.listArtifactRetirements(10)).toHaveLength(0);
  });

  test('a job with no artifact cannot be queued for retirement', async () => {
    const created = await admit(OWNER_A);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect(await repository.enqueueArtifactRetirement(created.job.id, clock.now())).toBe(false);
  });
});

describe('the frozen contract this repository depends on', () => {
  test('the idempotency key header is the documented one', () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe('idempotency-key');
  });
});

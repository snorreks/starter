// packages/backend/jobs/src/lib/maintenance_run.test.ts
//
// The durable run record, on a real SQLite engine with the committed migrations.
//
// What is under test is the claim the destructive part of the scheduler rests on:
// **one slot, one sweep.** The tests below create the same run key twice and
// assert that the second claim did not run, that a *stale* claim is taken over
// rather than left hanging forever, and that a manual run can never be recorded
// as a scheduled one.
//
// The naming follows this repository's rule: each test names the failure it would
// report, not the function it calls.

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Clock, JobsDatabase } from './job_repository.ts';
import {
  createMaintenanceRunRepository,
  describeRunRequest,
  MAINTENANCE_CRON,
  MAINTENANCE_RUN_TAKEOVER_MS,
  type MaintenanceReport,
  manualRunKey,
  scheduledRunKey,
  slotLabel,
} from './maintenance_run.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/backend/database/drizzle-d1');

const MIGRATIONS = readdirSync(MIGRATIONS_DIR)
  .filter((file) => file.endsWith('.sql'))
  .sort();

const migrate = (db: Database): void => {
  for (const file of MIGRATIONS) {
    for (const statement of readFileSync(join(MIGRATIONS_DIR, file), 'utf8').split(
      '--> statement-breakpoint',
    )) {
      if (statement.trim().length > 0) {
        db.exec(statement);
      }
    }
  }
};

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
            const rows = statement.all(...(values as never[])) as T[];
            return Promise.resolve({ results: rows, meta: changedRows(db) });
          },
          run() {
            statement.run(...(values as never[]));
            return Promise.resolve({ results: [], meta: changedRows(db) });
          },
          first<T>() {
            return Promise.resolve((statement.get(...(values as never[])) ?? null) as T | null);
          },
        };
      },
    };
  },
});

let nowMs = Date.UTC(2026, 9, 3, 17, 0, 0);
const clock: Clock = { now: () => nowMs };

let db: Database;
let repository: ReturnType<typeof createMaintenanceRunRepository>;

beforeEach(() => {
  db = new Database(':memory:');
  migrate(db);
  repository = createMaintenanceRunRepository(asD1(db), clock);
  nowMs = Date.UTC(2026, 9, 3, 17, 0, 0);
});

const report = (overrides: Partial<MaintenanceReport> = {}): MaintenanceReport => ({
  runKey: '',
  cutoffAt: nowMs,
  expiredSessions: 0,
  idleRateLimits: 0,
  artifactsQueued: 0,
  artifactsRetired: 0,
  pendingDispatches: 0,
  ...overrides,
});

describe('the run key', () => {
  test('two firings of one scheduled slot address the same run', () => {
    // 17:00:00 and 17:00:59 are the same hourly slot. A provider that delivers
    // one firing late, or twice, must not be able to start two sweeps.
    const slotStart = Date.UTC(2026, 9, 3, 17, 0, 0);
    expect(scheduledRunKey(slotStart)).toBe(scheduledRunKey(slotStart + 59_000));
    expect(slotLabel(slotStart)).toBe('2026-10-03T17:00:00Z');
    expect(slotLabel(slotStart + 59_000)).toBe(slotLabel(slotStart));
  });

  test('a different hour is a different run', () => {
    const first = Date.UTC(2026, 9, 3, 17, 0, 0);
    expect(scheduledRunKey(first)).not.toBe(scheduledRunKey(first + 3_600_000));
  });

  test('a sub-hourly schedule keeps its slots distinct', () => {
    // The slot floor is derived from the cron. If it were hardcoded to the hour,
    // a `*/15` schedule would collapse four slots into one and silently sweep
    // only one of them.
    const quarter = Date.UTC(2026, 9, 3, 17, 15, 0);
    expect(scheduledRunKey(quarter, '*/15 * * * *')).not.toBe(
      scheduledRunKey(Date.UTC(2026, 9, 3, 17, 30, 0), '*/15 * * * *'),
    );
  });

  test('a manual run can never be mistaken for a scheduled one', () => {
    // The two prefixes are the only thing separating operator evidence from
    // scheduler evidence, so this is asserted rather than assumed.
    const slotStart = Date.UTC(2026, 9, 3, 17, 0, 0);
    expect(manualRunKey(String(slotStart))).not.toBe(scheduledRunKey(slotStart));
    expect(manualRunKey('abc')).toMatch(/^manual:/);
    expect(scheduledRunKey(slotStart)).toMatch(/^scheduled:/);
  });

  test('the committed schedule is the frozen hourly slot, not minute zero', () => {
    // Minute 0 is when every other scheduled job on the platform fires.
    expect(MAINTENANCE_CRON).toBe('17 * * * *');
    const fields = MAINTENANCE_CRON.split(' ');
    expect(fields).toHaveLength(5);
    expect(fields[0]).toMatch(/^\d+$/);
    expect(Number(fields[0])).toBeGreaterThan(0);
    expect(Number(fields[0])).toBeLessThan(60);
  });

  test('a manual request carries no scheduled time or slot', () => {
    expect(describeRunRequest({ trigger: 'manual', requestId: 'r1' })).toEqual({
      runKey: 'manual:r1',
      slot: null,
      scheduledTime: null,
    });
  });
});

describe('claiming a run', () => {
  test('a second firing of one slot cannot start a second sweep', async () => {
    const scheduledTimeMs = Date.UTC(2026, 9, 3, 17, 0, 0);
    const first = await repository.begin({ trigger: 'scheduled', scheduledTimeMs }, nowMs);
    expect(first.ok).toBe(true);

    // 90 seconds later: still the same slot, long enough that a "too soon to
    // retry" excuse would not apply.
    nowMs = scheduledTimeMs + 90_000;
    const second = await repository.begin({ trigger: 'scheduled', scheduledTimeMs }, nowMs);

    expect(second.ok).toBe(false);
    if (second.ok) {
      throw new Error('unreachable');
    }
    expect(second.reason).toBe('in_progress');
    // One row, not two. The database is what makes the claim, so counting rows
    // is the only assertion that cannot be satisfied by a correct-looking report.
    const rows = db.query('SELECT count(*) AS n FROM maintenance_runs').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  test('a finished slot is never swept again, however late the retry arrives', async () => {
    const scheduledTimeMs = Date.UTC(2026, 9, 3, 17, 0, 0);
    await repository.begin({ trigger: 'scheduled', scheduledTimeMs }, nowMs);
    await repository.complete(
      scheduledRunKey(scheduledTimeMs),
      report({ runKey: scheduledRunKey(scheduledTimeMs), expiredSessions: 4 }),
    );

    // A day later. The takeover window has long expired; a *finished* run is
    // still finished, which is what stops a late delivery from repeating work
    // that already happened.
    nowMs = scheduledTimeMs + 24 * 3_600_000;
    const again = await repository.begin({ trigger: 'scheduled', scheduledTimeMs }, nowMs);
    expect(again.ok).toBe(false);
    if (again.ok) {
      throw new Error('unreachable');
    }
    expect(again.reason).toBe('already_finished');
  });

  test('a run abandoned by a crash is taken over rather than left hanging', async () => {
    const scheduledTimeMs = Date.UTC(2026, 9, 3, 17, 0, 0);
    await repository.begin({ trigger: 'scheduled', scheduledTimeMs }, nowMs);

    // A crashed instance leaves the row `running` forever. After the takeover
    // window, the next firing of that slot must be able to do the work.
    nowMs = scheduledTimeMs + MAINTENANCE_RUN_TAKEOVER_MS + 1_000;
    const takeover = await repository.begin({ trigger: 'scheduled', scheduledTimeMs }, nowMs);
    expect(takeover.ok).toBe(true);
    if (!takeover.ok) {
      throw new Error('unreachable');
    }
    expect(takeover.tookOver).toBe(true);
    // Second granularity: the column stores epoch seconds, so a run is stamped
    // to the second it started and never to a sub-second instant.
    expect(takeover.run.startedAt).toBe(Math.floor(nowMs / 1000) * 1000);

    const rows = db.query('SELECT count(*) AS n FROM maintenance_runs').get() as { n: number };
    expect(rows.n).toBe(1);
  });

  test('two manual requests are two runs, and one retried manual request is one', async () => {
    const first = await repository.begin({ trigger: 'manual', requestId: 'r1' }, nowMs);
    expect(first.ok).toBe(true);

    // A retried request: same id, so the destructive work must not run twice.
    const retried = await repository.begin({ trigger: 'manual', requestId: 'r1' }, nowMs);
    expect(retried.ok).toBe(false);

    // A different request: the operator asked for a second run.
    const second = await repository.begin({ trigger: 'manual', requestId: 'r2' }, nowMs);
    expect(second.ok).toBe(true);
  });
});

describe('finishing a run', () => {
  test('the recorded counts are the report, not a re-count', async () => {
    const key = await repository.begin({ trigger: 'manual', requestId: 'r1' }, nowMs);
    expect(key.ok).toBe(true);

    expect(
      await repository.complete(
        'manual:r1',
        report({
          runKey: 'manual:r1',
          expiredSessions: 3,
          idleRateLimits: 7,
          artifactsQueued: 2,
          artifactsRetired: 1,
          pendingDispatches: 4,
        }),
      ),
    ).toBe(true);

    const stored = await repository.get('manual:r1');
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('succeeded');
    expect(stored?.expiredSessions).toBe(3);
    expect(stored?.idleRateLimits).toBe(7);
    expect(stored?.artifactsQueued).toBe(2);
    expect(stored?.artifactsRetired).toBe(1);
    expect(stored?.pendingDispatches).toBe(4);
    expect(stored?.completedAt).toBe(nowMs);
  });

  test('a finished run cannot be completed or failed again', async () => {
    await repository.begin({ trigger: 'manual', requestId: 'r1' }, nowMs);
    await repository.complete('manual:r1', report());

    // The second write matches no rows. Without the `status = 'running'`
    // predicate this would overwrite a finished run's counts with a later,
    // different sweep's — which is the shape of "the last run says zero".
    expect(await repository.complete('manual:r1', report({ expiredSessions: 99 }))).toBe(false);
    expect(await repository.fail('manual:r1', 'sweep_failed')).toBe(false);

    const stored = await repository.get('manual:r1');
    expect(stored?.status).toBe('succeeded');
    expect(stored?.expiredSessions).toBe(0);
    expect(stored?.errorCode).toBeNull();
  });

  test('a failed run keeps a frozen code and its true counts', async () => {
    await repository.begin({ trigger: 'manual', requestId: 'r1' }, nowMs);
    expect(await repository.fail('manual:r1', 'sweep_failed')).toBe(true);

    const stored = await repository.get('manual:r1');
    expect(stored?.status).toBe('failed');
    expect(stored?.errorCode).toBe('sweep_failed');
    expect(stored?.completedAt).toBe(nowMs);
  });

  test('the newest run is the one a reader is shown', async () => {
    await repository.begin({ trigger: 'manual', requestId: 'older' }, nowMs);
    nowMs += 60_000;
    await repository.begin({ trigger: 'manual', requestId: 'newer' }, nowMs);

    const listed = await repository.list(10);
    expect(listed.map((run) => run.runKey)).toEqual(['manual:newer', 'manual:older']);
  });

  test('a scheduled run records the slot and the provider time it was given', async () => {
    const scheduledTimeMs = Date.UTC(2026, 9, 3, 17, 0, 0);
    await repository.begin(
      { trigger: 'scheduled', scheduledTimeMs, cron: MAINTENANCE_CRON },
      nowMs,
    );

    const stored = await repository.get(scheduledRunKey(scheduledTimeMs));
    expect(stored?.trigger).toBe('scheduled');
    expect(stored?.slot).toBe('2026-10-03T17:00:00Z');
    expect(stored?.scheduledTime).toBe(scheduledTimeMs);
  });
});

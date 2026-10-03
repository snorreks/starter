// packages/backend/jobs/src/lib/maintenance.test.ts
//
// Bounded maintenance, on a real SQLite engine with the real migrations.
//
// The three claims under test are the ones the round-2 review found broken in the
// previous `purgeExpiredSessions`:
//
//   * the delete is bounded, and the row count comes from the database's own
//     `changes()` rather than from a preceding `SELECT`;
//   * the cutoff is one value, supplied by the caller, so the report describes the
//     same instant the delete used;
//   * an artifact is only reported as retired after the storage owner has said the
//     bytes are gone.

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJobRepository, type JobsDatabase } from './job_repository.ts';
import {
  type ArtifactSweepRepository,
  type Clock,
  type JobArtifactStorage,
  MAX_MAINTENANCE_BATCH,
  type MaintenanceDatabase,
  purgeExpiredArtifacts,
  purgeExpiredSessions,
  purgeIdleRateLimits,
  runMaintenance,
} from './maintenance.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/backend/database/drizzle-d1');

/**
 * Every applied migration, in order.
 *
 * Discovered rather than listed, because a hardcoded list is a list that goes
 * stale: adding `0004_*.sql` and forgetting this array gives a suite that passes
 * against a schema one migration behind, which is the one thing a database test
 * must not do. `readdirSync` order is not guaranteed to be numeric on every
 * filesystem, hence the explicit sort.
 */
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
          first<T>(columnName?: string) {
            const row = statement.get(...(values as never[])) as Record<string, unknown> | null;
            if (row === null || row === undefined) {
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

const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);
const DAY = 86_400_000;
const HOUR = 3_600_000;

let sqlite: Database;
let db: MaintenanceDatabase;
let clock: Clock;

const seconds = (ms: number): number => Math.floor(ms / 1000);

const addSession = (id: string, expiresAtMs: number): void => {
  sqlite
    .query(
      'INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(id, 'user_alice', `token-${id}`, seconds(expiresAtMs), seconds(T0), seconds(T0));
};

const addRateLimit = (key: string, lastRequestMs: number): void => {
  sqlite
    .query('INSERT INTO rate_limits (key, count, last_request) VALUES (?, ?, ?)')
    .run(key, 3, lastRequestMs);
};

const sessionCount = (): number =>
  (sqlite.query('SELECT count(*) AS n FROM sessions').get() as { n: number }).n;

const rateLimitCount = (): number =>
  (sqlite.query('SELECT count(*) AS n FROM rate_limits').get() as { n: number }).n;

beforeEach(() => {
  sqlite = new Database(':memory:');
  migrate(sqlite);
  db = asD1(sqlite);
  const now = T0;
  clock = { now: () => now };
  sqlite.exec(
    "INSERT INTO users (id, name, email, email_verified) VALUES ('user_alice', 'Alice', 'a@example.invalid', 1)",
  );
  Object.defineProperty(clock, 'now', { value: () => now });
});

describe('purgeExpiredSessions', () => {
  test('deletes only sessions past the supplied cutoff', async () => {
    addSession('expired-1', T0 - HOUR);
    addSession('expired-2', T0 - 2 * HOUR);
    addSession('live-1', T0 + 7 * DAY);

    const deleted = await purgeExpiredSessions(db, { cutoffMs: T0 });

    expect(deleted).toBe(2);
    expect(sessionCount()).toBe(1);
  });

  test('the reported count is the rows deleted, not the rows selected', async () => {
    // The old implementation read a list and then deleted with a second, later
    // cutoff, so it reported the length of the *first* query. Two sessions whose
    // expiry sat exactly on the boundary is the case that separates the two
    // numbers: they are selected and then, with a moving clock, not deleted.
    addSession('boundary', T0);

    const deleted = await purgeExpiredSessions(db, { cutoffMs: T0 });

    // `expires_at < cutoff` is strict, so a session expiring exactly at the cutoff
    // is kept. Both the count and the surviving row agree.
    expect(deleted).toBe(0);
    expect(sessionCount()).toBe(1);

    // A whole second later, because the column is second-granular: `T0 + 1` is
    // still the same second and would not move the cutoff at all.
    const later = await purgeExpiredSessions(db, { cutoffMs: T0 + 1000 });
    expect(later).toBe(1);
    expect(sessionCount()).toBe(0);
  });

  test('a second run deletes nothing, because there is nothing left to delete', async () => {
    addSession('expired-1', T0 - HOUR);
    expect(await purgeExpiredSessions(db, { cutoffMs: T0 })).toBe(1);
    expect(await purgeExpiredSessions(db, { cutoffMs: T0 })).toBe(0);
  });

  test('the batch is a ceiling, not a suggestion', async () => {
    for (let index = 0; index < 150; index += 1) {
      addSession(`expired-${index}`, T0 - HOUR);
    }

    expect(await purgeExpiredSessions(db, { cutoffMs: T0, batch: 25 })).toBe(25);
    expect(sessionCount()).toBe(125);

    // Even an unbounded request is capped at the frozen maximum.
    const rest = await purgeExpiredSessions(db, { cutoffMs: T0, batch: 100_000 });
    expect(rest).toBe(MAX_MAINTENANCE_BATCH);
    expect(sessionCount()).toBe(25);
  });

  test('a nonsense batch is replaced by the default rather than deleting everything', async () => {
    for (let index = 0; index < 150; index += 1) {
      addSession(`expired-${index}`, T0 - HOUR);
    }

    // `NaN` reaching a LIMIT is either an error or, worse, no limit at all.
    const deleted = await purgeExpiredSessions(db, { cutoffMs: T0, batch: Number.NaN });
    expect(deleted).toBe(MAX_MAINTENANCE_BATCH);
    expect(sessionCount()).toBe(150 - MAX_MAINTENANCE_BATCH);
  });
});

describe('purgeIdleRateLimits', () => {
  test('deletes only windows nobody has touched since the cutoff', async () => {
    addRateLimit('1.0.0.1|/sign-in', T0 - 2 * DAY);
    // Recent enough that the cutoff below keeps it. The cutoff is the caller's
    // value, not `now - retention`: `runMaintenance` is what derives one from the
    // other, and this service is the narrower statement.
    addRateLimit('1.0.0.2|/sign-in', T0 - 60 * 1000);

    expect(await purgeIdleRateLimits(db, { cutoffMs: T0 - DAY })).toBe(1);
    expect(rateLimitCount()).toBe(1);
  });

  test('is bounded the same way', async () => {
    for (let index = 0; index < 120; index += 1) {
      addRateLimit(`key-${index}`, T0 - 2 * DAY);
    }
    expect(await purgeIdleRateLimits(db, { cutoffMs: T0, batch: 10 })).toBe(10);
    expect(rateLimitCount()).toBe(110);
  });
});

describe('purgeExpiredArtifacts', () => {
  interface Fixture {
    repository: ArtifactSweepRepository;
    removed: Set<string>;
    storage: JobArtifactStorage;
    queued: Array<{ jobId: string; cutoffAt: number }>;
    cleared: string[];
  }

  /**
   * A repository and storage pair backed by real tables.
   *
   * `removed` is the storage owner's answer to "are the bytes gone?", and the test
   * drives it. That is the only fake here: the SQL is real, and the answer is the
   * one thing this repository genuinely cannot know on its own.
   */
  const fixture = (): Fixture => {
    const removed = new Set<string>();
    const queued: Array<{ jobId: string; cutoffAt: number }> = [];
    const cleared: string[] = [];

    const realRepository = createJobRepository(asD1(sqlite), clock);
    const repository: ArtifactSweepRepository = {
      ...realRepository,
      async enqueueArtifactRetirement(jobId, cutoffMs) {
        const added = await realRepository.enqueueArtifactRetirement(jobId, cutoffMs);
        if (added) {
          queued.push({ jobId, cutoffAt: cutoffMs });
        }
        return added;
      },
      async clearJobOutput(jobId) {
        const changed = await realRepository.clearJobOutput(jobId);
        if (changed) {
          cleared.push(jobId);
        }
        return changed;
      },
    };

    return {
      repository,
      removed,
      queued,
      cleared,
      storage: {
        async isRemoved(outputKey) {
          return removed.has(outputKey);
        },
      },
    };
  };

  const addJobWithArtifact = (id: string, expiresAtMs: number): void => {
    sqlite
      .query(
        `INSERT INTO jobs (
           id, owner_id, kind, status, fixture, preset, idempotency_key, request_fingerprint,
           workflow_id, dispatch_state, attempt_count, output_key, output_bytes, output_sha256,
           output_expires_at, created_at, updated_at
         ) VALUES (?, 'user_alice', 'encode', 'succeeded', 'sample-v1', 'demo-180p-v1', ?,
                   '{}', ?, 'dispatched', 1, ?, 4096, ?, ?, ?, ?)`,
      )
      .run(
        id,
        `key-${id}`,
        `encode-${id}`,
        `jobs/${id}.mp4`,
        'a'.repeat(64),
        seconds(expiresAtMs),
        seconds(T0),
        seconds(T0),
      );
  };

  test('an artifact is queued, and only retired once the bytes are gone', async () => {
    addJobWithArtifact('job_a', T0 - HOUR);
    const world = fixture();

    // First run: the artifact is due, so it is queued. Nobody has confirmed the
    // bytes are gone, so nothing is reported as retired.
    const first = await purgeExpiredArtifacts(world.repository, world.storage, { cutoffMs: T0 });
    expect(first.queued).toBe(1);
    expect(first.retired).toBe(0);
    expect(first.outstanding).toBe(1);
    expect(world.queued.map((entry) => entry.jobId)).toEqual(['job_a']);
    expect(world.cleared).toEqual([]);

    // The storage owner deletes the object.
    world.removed.add('jobs/job_a.mp4');

    const second = await purgeExpiredArtifacts(world.repository, world.storage, { cutoffMs: T0 });
    expect(second.queued).toBe(0);
    expect(second.retired).toBe(1);
    expect(second.outstanding).toBe(0);
    expect(world.cleared).toEqual(['job_a']);

    // And the job keeps saying `succeeded` while claiming no artifact: the encode
    // happened, the bytes aged out, and neither fact is invented away.
    const job = sqlite.query('SELECT status, output_key FROM jobs WHERE id = ?').get('job_a');
    expect(job).toEqual({ status: 'succeeded', output_key: null });
  });

  test('an artifact whose bytes are still present stays queued and is retried next run', async () => {
    addJobWithArtifact('job_a', T0 - HOUR);
    const world = fixture();

    await purgeExpiredArtifacts(world.repository, world.storage, { cutoffMs: T0 });
    const again = await purgeExpiredArtifacts(world.repository, world.storage, { cutoffMs: T0 });

    expect(again.queued).toBe(0);
    expect(sqlite.query('SELECT runs FROM job_artifact_retirements').get()).toEqual({ runs: 2 });
    expect(again.outstanding).toBe(1);
    expect(again.retired).toBe(0);
    expect(world.cleared).toEqual([]);
  });

  test('failed retirements do not starve later artifacts', async () => {
    addJobWithArtifact('job_a', T0 - HOUR);
    addJobWithArtifact('job_b', T0 - HOUR);
    const world = fixture();
    await purgeExpiredArtifacts(world.repository, world.storage, { cutoffMs: T0, batch: 1 });
    world.removed.add('jobs/job_b.mp4');
    expect(
      await purgeExpiredArtifacts(world.repository, world.storage, { cutoffMs: T0, batch: 1 }),
    ).toEqual({ queued: 1, retired: 1, outstanding: 1 });
    expect(world.cleared).toEqual(['job_b']);
  });

  test('an artifact that is not yet due is neither queued nor retired', async () => {
    addJobWithArtifact('job_a', T0 + HOUR);
    const world = fixture();

    const report = await purgeExpiredArtifacts(world.repository, world.storage, { cutoffMs: T0 });
    expect(report).toEqual({ queued: 0, retired: 0, outstanding: 0 });
  });

  test('the sweep is bounded', async () => {
    for (let index = 0; index < 150; index += 1) {
      addJobWithArtifact(`job_${String(index).padStart(3, '0')}`, T0 - HOUR);
    }
    const world = fixture();

    const report = await purgeExpiredArtifacts(world.repository, world.storage, {
      cutoffMs: T0,
      batch: 20,
    });
    expect(report.queued).toBe(20);
    expect(world.queued).toHaveLength(20);
  });
});

describe('runMaintenance', () => {
  test('stale dispatch failures release the owner slot while recent failures stay recoverable', async () => {
    const repository = createJobRepository(asD1(sqlite), clock);
    const input = { fixture: 'sample-v1', preset: 'demo-180p-v1' } as const;
    expect((await repository.createEncodeJob('user_alice', input, 'key-a', 'job_a')).ok).toBe(true);
    expect(await repository.markDispatchFailed('job_a', 'provider_unavailable')).toBe(true);
    await runMaintenance(db, repository, { isRemoved: async () => false }, clock, {
      runKey: 'recent',
    });
    expect((await repository.getJobForOwner('user_alice', 'job_a'))?.status).toBe('pending');
    sqlite.query('UPDATE jobs SET updated_at = ? WHERE id = ?').run(seconds(T0 - HOUR), 'job_a');
    const report = await runMaintenance(db, repository, { isRemoved: async () => false }, clock, {
      runKey: 'stale',
    });
    expect(report.pendingDispatches).toBe(0);
    expect(await repository.getJobForOwner('user_alice', 'job_a')).toMatchObject({
      status: 'failed',
      activeAttemptId: null,
    });
    expect((await repository.createEncodeJob('user_alice', input, 'key-b', 'job_b')).ok).toBe(true);
  });

  test('one cutoff for the whole run, and every count is the rows affected', async () => {
    addSession('expired-1', T0 - 8 * DAY);
    addSession('expired-2', T0 - 9 * DAY);
    addSession('live-1', T0 + DAY);
    addRateLimit('idle|1', T0 - 30 * 60 * 60 * 1000);
    addRateLimit('busy|1', T0 - 1000);

    const noJobs = createJobRepository(asD1(sqlite), clock);

    const report = await runMaintenance(db, noJobs, { isRemoved: async () => false }, clock, {
      runKey: '2026-10-05T12',
    });

    expect(report.runKey).toBe('2026-10-05T12');
    // The single instant the whole run used. A run that took `new Date()` per
    // service would report a cutoff that describes no instant any delete used.
    expect(report.cutoffAt).toBe(T0);
    expect(report.expiredSessions).toBe(2);
    expect(report.idleRateLimits).toBe(1);
    expect(report.artifactsQueued).toBe(0);
    expect(report.artifactsRetired).toBe(0);
    expect(report.pendingDispatches).toBe(0);
  });

  test('reports how many admitted jobs are still owed a dispatch', async () => {
    // Terminal status, deliberately: one owner may hold only one *active* job, so a
    // backlog of undispatched jobs is by definition a set of finished ones, and
    // writing them as pending would trip the partial unique index rather than
    // testing the sweep.
    for (let index = 0; index < 3; index += 1) {
      sqlite
        .query(
          `INSERT INTO jobs (
             id, owner_id, kind, status, fixture, preset, idempotency_key, request_fingerprint,
             workflow_id, dispatch_state, dispatch_error, dispatch_attempts, attempt_count,
             created_at, updated_at
           ) VALUES (?, 'user_alice', 'encode', 'failed', 'sample-v1', 'demo-180p-v1', ?,
                     '{}', ?, 'dispatch_failed', 'workflow_binding_missing', 1, 0, ?, ?)`,
        )
        .run(`job_${index}`, `key-${index}`, `encode-job_${index}`, seconds(T0), seconds(T0));
    }

    const report = await runMaintenance(
      db,
      createJobRepository(asD1(sqlite), clock),
      { isRemoved: async () => false },
      clock,
      { runKey: 'slot-1' },
    );

    expect(report.pendingDispatches).toBe(3);
  });
});

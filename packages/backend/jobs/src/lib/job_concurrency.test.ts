// packages/backend/jobs/src/lib/job_concurrency.test.ts
//
// The claims that are about *concurrency*, kept apart from the behavioural suite
// so a failure names the property rather than a symptom.
//
// What each test below does and does not prove is stated at the test. The short
// version: `bun:sqlite` on one connection serialises statements, so nothing here
// observes two threads racing. What these tests *can* observe, and do, is that the
// admission decision is one statement — which is the property that makes the
// database-side guarantee hold when two Worker isolates do race.

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Clock,
  createJobRepository,
  type JobRepository,
  type JobsDatabase,
} from './job_repository.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
const MIGRATIONS_DIR = join(REPO_ROOT, 'packages/backend/database/drizzle-d1');

/**
 * Every applied migration, in order, discovered rather than listed.
 *
 * A hardcoded list is a list that goes stale, and a suite that silently tests a
 * schema one migration behind is worse than no suite: it reports the jobs tables
 * as they were before the newest migration changed them.
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

/**
 * The D1 surface, plus a transcript of every statement the repository issues.
 *
 * The transcript is the point of this file: it lets a test assert something about
 * *how many statements* a decision took, which is the only way to distinguish an
 * atomic decision from a read-then-write one that happens to agree when nothing
 * else is running.
 */
const instrumentedD1 = (db: Database, transcript: string[]): JobsDatabase => ({
  prepare(query: string) {
    const statement = db.query(query);
    return {
      bind(...values: unknown[]) {
        const record = (): void => {
          transcript.push(query.replace(/\s+/g, ' ').trim());
        };
        return {
          all<T>() {
            record();
            const rows = statement.all(...(values as never[])) as T[];
            return Promise.resolve({ results: rows, meta: changedRows(db) });
          },
          run() {
            record();
            statement.run(...(values as never[]));
            return Promise.resolve({ meta: changedRows(db), results: [] as never[] });
          },
          first<T>(columnName?: string) {
            record();
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
const clock: Clock = { now: () => T0 };

let sqlite: Database;
let transcript: string[];
let repository: JobRepository;

const OWNER_A = 'user_alice';
const OWNER_B = 'user_bob';
const request = () => ({ fixture: 'sample-v1', preset: 'demo-180p-v1' }) as const;

beforeEach(() => {
  sqlite = new Database(':memory:');
  migrate(sqlite);
  sqlite.exec(
    "INSERT INTO users (id, name, email, email_verified) VALUES ('user_alice', 'Alice', 'a@example.invalid', 1), ('user_bob', 'Bob', 'b@example.invalid', 1)",
  );
  transcript = [];
  repository = createJobRepository(instrumentedD1(sqlite, transcript), clock);
});

const jobRows = (): Array<{ id: string; owner_id: string; idempotency_key: string }> =>
  sqlite.query('SELECT id, owner_id, idempotency_key FROM jobs ORDER BY id').all() as Array<{
    id: string;
    owner_id: string;
    idempotency_key: string;
  }>;

describe('the admission decision is one statement', () => {
  test('a fresh admission issues no separate budget count before its insert', () => {
    // The negative control for the whole design. A read-then-write implementation
    // — `SELECT count(*) …` then `INSERT` — passes every behavioural test in the
    // sibling suite when nothing else is running, and overruns every cap the moment
    // two requests overlap. This test fails for that implementation and passes for
    // this one, which is the only way to tell them apart from inside one process.
    transcript.length = 0;
    return repository.createEncodeJob(OWNER_A, request(), 'key-1', 'job-1').then(() => {
      const standaloneCounts = transcript.filter(
        (statement) => /^SELECT count\(\*\)/i.test(statement) && /FROM jobs/i.test(statement),
      );
      expect(standaloneCounts).toEqual([]);

      const inserts = transcript.filter((statement) => /^INSERT INTO jobs/i.test(statement));
      expect(inserts).toHaveLength(1);
      // And the budgets are inside that statement, not merely absent.
      expect(inserts[0]).toContain('WHERE (SELECT count(*) FROM jobs WHERE owner_id = ?');
      expect(inserts[0]).toContain('ON CONFLICT DO NOTHING');
    });
  });

  test('the refusal path also decides in one statement', () => {
    // A repository that read the counts to decide and only then wrote would pass
    // the test above while still racing. Asserted on the *second* admission too:
    // the counters used to explain a refusal are allowed to exist, but not before
    // the inserting statement has already refused.
    return repository
      .createEncodeJob(OWNER_A, request(), 'key-1', 'job-1')
      .then(() => {
        transcript.length = 0;
        return repository.createEncodeJob(OWNER_A, request(), 'key-2', 'job-2');
      })
      .then(() => {
        const insertIndex = transcript.findIndex((statement) =>
          /^INSERT INTO jobs/i.test(statement),
        );
        expect(insertIndex).toBeGreaterThanOrEqual(0);

        const countStatements = transcript.filter((statement) =>
          /^SELECT count\(\*\)/i.test(statement),
        );
        // Every explanatory count comes after the statement that refused.
        for (const statement of countStatements) {
          expect(transcript.indexOf(statement)).toBeGreaterThan(insertIndex);
        }
      });
  });
});

describe('overlapping admissions', () => {
  test('the same key, issued together, yields one job', async () => {
    // The adapter resolves asynchronously, so these admissions interleave at every
    // `await` the repository performs. What that does *not* prove is that two
    // threads raced — `bun:sqlite` serialises statements — and this test does not
    // claim to. What it does prove is that the repository has no read-then-write
    // window that the interleaving can slip through, which is the same property a
    // real race would exercise and the sibling suite's structural test pins.
    const outcomes = await Promise.all([
      repository.createEncodeJob(OWNER_A, request(), 'same-key', 'job-a'),
      repository.createEncodeJob(OWNER_A, request(), 'same-key', 'job-b'),
      repository.createEncodeJob(OWNER_A, request(), 'same-key', 'job-c'),
    ]);

    expect(jobRows()).toHaveLength(1);
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) {
        continue;
      }
      expect(outcome.job.id).toBe('job-a');
    }

    // One budget spend, one job, and every caller got the same answer.
    const replays = outcomes.filter((outcome) => outcome.ok && outcome.replayed).length;
    expect(replays).toBe(2);
  });

  test('distinct keys for one user cannot both be admitted', async () => {
    const outcomes = await Promise.all([
      repository.createEncodeJob(OWNER_A, request(), 'key-1', 'job-1'),
      repository.createEncodeJob(OWNER_A, request(), 'key-2', 'job-2'),
      repository.createEncodeJob(OWNER_A, request(), 'key-3', 'job-3'),
    ]);

    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(2);
    expect(jobRows()).toHaveLength(1);

    for (const outcome of outcomes) {
      if (outcome.ok) {
        continue;
      }
      expect(outcome.reason).toBe('budget_exceeded');
      expect(outcome.budget).toBe('active');
    }
  });

  test('distinct keys for different users are each admitted exactly once', async () => {
    const outcomes = await Promise.all([
      repository.createEncodeJob(OWNER_A, request(), 'key-1', 'job-1'),
      repository.createEncodeJob(OWNER_B, request(), 'key-1', 'job-2'),
    ]);

    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(jobRows()).toHaveLength(2);
  });

  test('the same key admitted for two owners produces two jobs and reads back separately', async () => {
    // Owner-scoped idempotency is what stops one user's retry from colliding with
    // another's, and — more importantly — from returning the other user's job.
    const [a, b] = await Promise.all([
      repository.createEncodeJob(OWNER_A, request(), 'shared', 'job-a'),
      repository.createEncodeJob(OWNER_B, request(), 'shared', 'job-b'),
    ]);

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) {
      return;
    }
    expect(a.job.id).not.toBe(b.job.id);
    expect(a.job.ownerId).toBe(OWNER_A);
    expect(b.job.ownerId).toBe(OWNER_B);

    // Each owner sees exactly their own, and the other's id is not even reachable.
    expect((await repository.listJobsForOwner(OWNER_A)).jobs.map((job) => job.id)).toEqual([
      'job-a',
    ]);
    expect(await repository.getJobForOwner(OWNER_A, 'job-b')).toBeNull();
    expect(await repository.getJobForOwner(OWNER_B, 'job-a')).toBeNull();
  });
});

describe('a stored key that disagrees with the request', () => {
  test('the same key with a different recorded body is refused as a conflict', async () => {
    // Reachable, and worth reaching: today's `fixture` and `preset` are each a
    // single frozen value, so a *validated* request cannot differ from itself and
    // the route's 409 is a defensive branch. It is still reachable, because a row
    // can have been admitted by an earlier build of this template that accepted a
    // second preset, or written by a maintenance job. Inserting that row directly
    // is how the branch is proved rather than assumed.
    const nowSeconds = Math.floor(T0 / 1000);
    sqlite
      .query(
        `INSERT INTO jobs (
           id, owner_id, kind, status, fixture, preset, idempotency_key,
           request_fingerprint, workflow_id, dispatch_state, dispatch_attempts,
           attempt_count, created_at, updated_at
         ) VALUES ('job-old', ?, 'encode', 'failed', 'sample-v1', 'uhd-2160p-v1', 'reused-key',
                   '{"fixture":"sample-v1","preset":"uhd-2160p-v1"}', 'encode-job-old',
                   'dispatched', 1, 1, ?, ?)`,
      )
      .run(OWNER_A, nowSeconds, nowSeconds);

    const outcome = await repository.createEncodeJob(OWNER_A, request(), 'reused-key', 'job-new');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('idempotency_conflict');
    // And no second row was written: a conflict does not admit a replacement.
    expect(jobRows()).toHaveLength(1);
  });

  test('the other user is unaffected by a key held by somebody else', async () => {
    const nowSeconds = Math.floor(T0 / 1000);
    sqlite
      .query(
        `INSERT INTO jobs (
           id, owner_id, kind, status, fixture, preset, idempotency_key,
           request_fingerprint, workflow_id, dispatch_state, attempt_count,
           created_at, updated_at
         ) VALUES ('job-old', ?, 'encode', 'failed', 'sample-v1', 'demo-180p-v1', 'reused-key',
                   '{"fixture":"sample-v1","preset":"uhd-2160p-v1"}', 'encode-job-old',
                   'dispatched', 1, ?, ?)`,
      )
      .run(OWNER_A, nowSeconds, nowSeconds);

    const other = await repository.createEncodeJob(OWNER_B, request(), 'reused-key', 'job-b');
    expect(other.ok).toBe(true);
    if (!other.ok) {
      return;
    }
    expect(other.job.id).toBe('job-b');
    expect(other.job.ownerId).toBe(OWNER_B);
  });
});

// apps/frontend/client/src/lib/server/jobs_service.test.ts
//
// The server service: capability, DTO mapping, dispatch bookkeeping, and the four
// distinguishable output refusals.
//
// On a real SQLite engine with the committed migrations, because the service's
// decisions are downstream of the repository's SQL and a recorder would prove
// only that this file calls the repository. `database_paths.ts` is the existing
// helper that locates the migrations, so the same files the Worker lane applies
// are the ones applied here.

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkflowDispatchPort } from '@starter/jobs';
import { databaseMigrationsDir } from '../../../tests/database_paths.ts';
import { GET as outputRoute } from '../../routes/api/jobs/[id]/output/+server.ts';
import {
  createJobsService,
  JOBS_PROFILE_DISABLED,
  JOBS_PROFILE_ENCODE,
  MAX_OUTPUT_RANGE_BYTES,
  parseByteRange,
  toJobDto,
} from './jobs_service.ts';

const migrate = (db: Database): void => {
  for (const file of [
    '0000_graceful_grey_gargoyle.sql',
    '0001_early_captain_cross.sql',
    '0002_broken_vector.sql',
    '0003_dark_phantom_reporter.sql',
  ]) {
    for (const statement of readFileSync(join(databaseMigrationsDir, file), 'utf8').split(
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

const asJobsDatabase = (db: Database) => ({
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
            return Promise.resolve({ meta: changedRows(db), results: [] });
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
const HOUR = 3_600_000;
const OWNER_A = 'user_alice';
const OWNER_B = 'user_bob';
const request = () => ({ fixture: 'sample-v1', preset: 'demo-180p-v1' }) as const;

let sqlite: Database;
let now = T0;
let dispatchCalls: Array<{ jobId: string; workflowId: string; attemptId: string }> = [];

const recordingDispatch = (answer: 'ok' | 'fail' = 'ok'): WorkflowDispatchPort => ({
  async dispatch(target) {
    dispatchCalls.push({
      jobId: target.jobId,
      workflowId: target.workflowId,
      attemptId: target.attemptId,
    });
    return answer === 'ok'
      ? { ok: true }
      : {
          ok: false,
          code: 'workflow_binding_missing',
          message: 'no workflow binding',
          retryable: true,
        };
  },
});

const serviceWith = (
  profile: string = JOBS_PROFILE_ENCODE,
  dispatch: WorkflowDispatchPort = recordingDispatch(),
) =>
  createJobsService({
    db: asJobsDatabase(sqlite),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural match
    profile: profile as never,
    clock: { now: () => now },
    dispatch,
  });

beforeEach(() => {
  sqlite = new Database(':memory:');
  migrate(sqlite);
  sqlite.exec(
    "INSERT INTO users (id, name, email, email_verified) VALUES ('user_alice', 'Alice', 'a@example.invalid', 1), ('user_bob', 'Bob', 'b@example.invalid', 1)",
  );
  now = T0;
  dispatchCalls = [];
});

describe('resolveJobsProfile, through the service', () => {
  test('the disabled profile refuses a create and admits nothing to the database', async () => {
    const service = serviceWith(JOBS_PROFILE_DISABLED);

    const outcome = await service.create(OWNER_A, request(), 'key-1');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('jobs_profile_disabled');

    // Not merely refused: nothing was written. A "disabled" that still spent
    // budget would be worse than useless.
    expect(sqlite.query('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 0 });
    expect(dispatchCalls).toEqual([]);
  });

  test('the enabled profile admits, dispatches and reports the job', async () => {
    const outcome = await serviceWith().create(OWNER_A, request(), 'key-1');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.job.status).toBe('pending');
    expect(outcome.replayed).toBe(false);
    // The instance id the dispatch carried is derived from the job, not chosen.
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0]?.workflowId).toBe(`encode-${outcome.job.id}`);

    const row = sqlite.query('SELECT dispatch_state FROM jobs').get() as { dispatch_state: string };
    expect(row.dispatch_state).toBe('dispatched');
  });

  test('a replay does not dispatch a second time', async () => {
    const service = serviceWith();
    const first = await service.create(OWNER_A, request(), 'retry-key');
    const second = await service.create(OWNER_A, request(), 'retry-key');

    expect(first.ok && second.ok).toBe(true);
    expect(second.ok && second.replayed).toBe(true);
    // One Workflow instance, addressed by a deterministic id. A second dispatch
    // would be a second start of the same instance on every client retry.
    expect(dispatchCalls).toHaveLength(1);
    expect(sqlite.query('SELECT count(*) AS n FROM jobs').get()).toEqual({ n: 1 });
  });

  test('a failed dispatch still leaves a committed, visible, recoverable job', async () => {
    const service = serviceWith(JOBS_PROFILE_ENCODE, recordingDispatch('fail'));

    const outcome = await service.create(OWNER_A, request(), 'key-1');
    // 202, not an error: the admission is committed and the caller has a job id.
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.job.status).toBe('pending');

    const serviceAfter = serviceWith();
    const listed = await serviceAfter.list(OWNER_A);
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    expect(listed.page.jobs.map((job) => job.id)).toEqual([outcome.job.id]);

    // And it is owed a dispatch, which is what a recovery pass looks for.
    const repository = serviceAfter.repository();
    const pending = await repository.listPendingDispatches(10);
    expect(pending.map((job) => job.id)).toEqual([outcome.job.id]);
    expect(pending[0]?.dispatchError).toBe('workflow_binding_missing');
  });

  test('a second job while one is active is refused with the budget code', async () => {
    const service = serviceWith();
    expect((await service.create(OWNER_A, request(), 'key-1')).ok).toBe(true);

    const second = await service.create(OWNER_A, request(), 'key-2');
    expect(second.ok).toBe(false);
    if (second.ok) {
      return;
    }
    expect(second.code).toBe('budget_exceeded');
    expect(second.detail).toMatch(/not finished/i);
  });
});

describe('ownership through the service', () => {
  test('a malformed cursor is an explicit refusal', async () => {
    expect(await serviceWith().list(OWNER_A, { cursor: 'not-a-cursor' })).toMatchObject({
      ok: false,
      code: 'invalid_cursor',
    });
  });

  test("one user cannot read another user's job by a guessed id", async () => {
    const service = serviceWith();
    const created = await service.create(OWNER_A, request(), 'key-1');
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    // Not yours and not there answer identically. A 403 here would confirm the job
    // exists and turn the endpoint into an existence oracle.
    expect(await service.get(OWNER_B, created.job.id)).toBeNull();
    expect(await service.get(OWNER_B, 'job_does_not_exist')).toBeNull();
    expect((await service.get(OWNER_A, created.job.id))?.id).toBe(created.job.id);
  });

  test("a list never contains another user's job", async () => {
    const service = serviceWith();
    const alice = await service.create(OWNER_A, request(), 'key-a');
    const bob = await service.create(OWNER_B, request(), 'key-b');
    expect(alice.ok).toBe(true);
    expect(bob.ok).toBe(true);
    if (!alice.ok || !bob.ok) {
      return;
    }

    const outcome = await service.list(OWNER_A);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const page = outcome.page;
    expect(page.jobs).toHaveLength(1);
    expect(page.jobs.map((job) => job.id)).toEqual([alice.job.id]);
    expect(page.serverTime).toBe(now);
  });

  test('a list exposes no owner id and no storage key', async () => {
    const service = serviceWith();
    await service.create(OWNER_A, request(), 'key-1');
    const outcome = await service.list(OWNER_A);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    const page = outcome.page;
    for (const job of page.jobs) {
      expect(Object.keys(job).sort()).toEqual([
        'createdAt',
        'errorCode',
        'id',
        'kind',
        'outputAvailable',
        'status',
        'updatedAt',
      ]);
    }
  });
});

describe('output reads', () => {
  const succeed = async (jobId: string, key: string, expiresAt: number): Promise<void> => {
    const repository = serviceWith().repository();
    await repository.claimAttempt(jobId, 'attempt-1', now + HOUR);
    await repository.completeAttempt(jobId, 'attempt-1', {
      key,
      bytes: 4096,
      sha256: 'a'.repeat(64),
      containerFormat: 'mp4',
      videoCodec: 'h264',
      width: 320,
      height: 180,
      durationMs: 3000,
      expiresAt,
    });
  };

  test("another user's result is not found", async () => {
    const service = serviceWith();
    const created = await service.create(OWNER_A, request(), 'key-1');
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await succeed(created.job.id, 'jobs/a.mp4', now + 24 * HOUR);

    const outcome = await service.readOutput(OWNER_B, created.job.id, null);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('not_found');
  });

  test('a job that has not succeeded reports not-ready, not not-found', async () => {
    const service = serviceWith();
    const created = await service.create(OWNER_A, request(), 'key-1');
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const outcome = await service.readOutput(OWNER_A, created.job.id, null);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    // 409, not 404. A client that cannot tell "not finished" from "not yours"
    // either retries forever or tells a real user their job does not exist.
    expect(outcome.code).toBe('output_not_ready');
  });

  test('an aged-out artifact is expired, not missing, and the job still says succeeded', async () => {
    const service = serviceWith();
    const created = await service.create(OWNER_A, request(), 'key-1');
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await succeed(created.job.id, 'jobs/a.mp4', now + 24 * HOUR);

    now = T0 + 24 * HOUR + 1000;
    const outcome = await service.readOutput(OWNER_A, created.job.id, null);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.code).toBe('output_expired');

    const job = await service.get(OWNER_A, created.job.id);
    expect(job?.status).toBe('succeeded');
    // …and it no longer claims an artifact.
    expect(job?.outputAvailable).toBe(false);
  });

  test('a rejected range returns 416 with the artifact length and never reads storage', async () => {
    let reads = 0;
    const service = createJobsService({
      db: asJobsDatabase(sqlite),
      profile: JOBS_PROFILE_ENCODE,
      clock: { now: () => now },
      reader: {
        async read() {
          reads += 1;
          return null;
        },
      },
    });
    const created = await service.create(OWNER_A, request(), 'range-test');
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await succeed(created.job.id, 'jobs/a.mp4', now + 24 * HOUR);
    for (const range of ['bytes=4096-', 'garbage', 'bytes=0-1,3-4']) {
      const response = await outputRoute({
        locals: { user: { id: OWNER_A }, container: { jobsProfile: 'encode', jobs: service } },
        params: { id: created.job.id },
        request: new Request('http://localhost/api/jobs/output', { headers: { range } }),
      } as Parameters<typeof outputRoute>[0]);
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */4096');
      expect(await response.json()).toMatchObject({ error: 'range_not_satisfiable' });
    }
    expect(reads).toBe(0);
    expect(await service.readOutput(OWNER_A, created.job.id, null)).toMatchObject({
      ok: false,
      code: 'output_unavailable',
    });
    expect(reads).toBe(1);
  });

  test('with no artifact store bound, a readable job reports the capability, not a broken stream', async () => {
    const service = serviceWith();
    const created = await service.create(OWNER_A, request(), 'key-1');
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await succeed(created.job.id, 'jobs/a.mp4', now + 24 * HOUR);

    const outcome = await service.readOutput(OWNER_A, created.job.id, null);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    // A 200 with no bytes would look like a zero-byte video. Naming the missing
    // capability is the whole point of this PR having no object store.
    expect(outcome.code).toBe('output_unavailable');
    expect(outcome.detail).toMatch(/artifact store/i);
  });
});

describe('parseByteRange', () => {
  const TOTAL = 4096;

  test('an absent header means the whole artifact', () => {
    expect(parseByteRange(null, TOTAL)).toEqual({ ok: true, range: null });
    expect(parseByteRange('   ', TOTAL)).toEqual({ ok: true, range: null });
  });

  test('an explicit range is honoured and clamped to the artifact', () => {
    expect(parseByteRange('bytes=0-99', TOTAL)).toEqual({
      ok: true,
      range: { startInclusive: 0, endInclusive: 99 },
    });
    // A client asking past the end gets the end, which is what RFC 9110 says a
    // server does — and not an error a player would treat as a dead link.
    expect(parseByteRange('bytes=4000-99999', TOTAL)).toEqual({
      ok: true,
      range: { startInclusive: 4000, endInclusive: 4095 },
    });
  });

  test('an open-ended range runs to the end', () => {
    expect(parseByteRange('bytes=4090-', TOTAL)).toEqual({
      ok: true,
      range: { startInclusive: 4090, endInclusive: 4095 },
    });
  });

  test('a suffix range counts back from the end', () => {
    expect(parseByteRange('bytes=-100', TOTAL)).toEqual({
      ok: true,
      range: { startInclusive: 3996, endInclusive: 4095 },
    });
    // A suffix longer than the artifact is the whole artifact, not an error.
    expect(parseByteRange('bytes=-99999', TOTAL)).toEqual({
      ok: true,
      range: { startInclusive: 0, endInclusive: 4095 },
    });
  });

  test('multi-range is refused rather than silently served whole', () => {
    // Serving the whole object for a header the caller believed was a slice is
    // how a player ends up downloading the file to play three seconds of it.
    const outcome = parseByteRange('bytes=0-99,200-299', TOTAL);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.problem).toMatch(/single byte range/i);
  });

  test('a range past the end is refused', () => {
    expect(parseByteRange('bytes=5000-6000', TOTAL).ok).toBe(false);
  });

  test('a range wider than the ceiling is refused', () => {
    // The ceiling is a *per-request* byte bound, so it only bites on an artifact
    // big enough to have one. A range past the end of a small artifact is clamped
    // to the artifact above, which is what RFC 9110 says to do.
    const big = MAX_OUTPUT_RANGE_BYTES * 2;
    const outcome = parseByteRange(`bytes=0-${big}`, big);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.problem).toMatch(/larger than this endpoint/i);

    // Exactly the ceiling is allowed. An off-by-one here would either refuse a
    // legitimate slice or hand out one byte more than it promised to bound.
    expect(parseByteRange(`bytes=0-${MAX_OUTPUT_RANGE_BYTES - 1}`, big).ok).toBe(true);
    expect(MAX_OUTPUT_RANGE_BYTES).toBe(8 * 1024 * 1024);
  });

  test('a nonsense header is refused rather than ignored', () => {
    for (const header of ['items=0-1', 'bytes=', 'bytes=-0', 'bytes=abc-def', 'bytes=10-5']) {
      expect(parseByteRange(header, TOTAL).ok).toBe(false);
    }
  });
});

describe('toJobDto', () => {
  const record = (overrides: Record<string, unknown> = {}) => ({
    id: 'job_1',
    ownerId: 'user_alice',
    kind: 'encode' as const,
    status: 'succeeded' as const,
    fixture: 'sample-v1' as const,
    preset: 'demo-180p-v1' as const,
    idempotencyKey: 'k',
    requestFingerprint: '{}',
    workflowId: 'encode-job_1',
    dispatchState: 'dispatched' as const,
    dispatchAttempts: 1,
    dispatchError: null,
    activeAttemptId: null,
    attemptCount: 1,
    outputKey: 'jobs/a.mp4',
    output: {
      bytes: 4096,
      sha256: 'a'.repeat(64),
      containerFormat: 'mp4',
      videoCodec: 'h264',
      width: 320,
      height: 180,
      durationMs: 3000,
      expiresAt: T0 + 24 * HOUR,
    },
    errorCode: null,
    createdAt: T0,
    updatedAt: T0,
    completedAt: T0,
    ...overrides,
  });

  test('a succeeded job inside its retention window reports its artifact available', () => {
    expect(toJobDto(record() as never, T0).outputAvailable).toBe(true);
  });

  test('the same job one second past its cutoff reports unavailable and still succeeded', () => {
    const dto = toJobDto(record() as never, T0 + 24 * HOUR + 1000);
    expect(dto.outputAvailable).toBe(false);
    expect(dto.status).toBe('succeeded');
  });

  test('a pending job never reports an artifact', () => {
    expect(
      toJobDto(record({ status: 'pending', output: null, outputKey: null }) as never, T0)
        .outputAvailable,
    ).toBe(false);
  });
});

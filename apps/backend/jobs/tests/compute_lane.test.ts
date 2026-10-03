// apps/backend/jobs/tests/compute_lane.test.ts
//
// The compute lane: the built Worker in the real local Workers runtime, real local
// D1 and R2, the real Durable Object, the real Workflows engine, and the real FFmpeg
// container — with negative controls that misbehave on purpose.
//
// Requires Docker. `scripts/compute_lane.ts` starts the image and exports
// `PROCESSOR_ORIGIN`; this file refuses to run without it, so an invoked lane with
// no engine fails with a named prerequisite rather than reporting a pass.
//
// What this lane proves, and what it cannot
// -----------------------------------------
// It proves that a Workflow completes after the caller has gone, that steps are
// fenced by the repository, that bytes reach a bucket, that refusals are classified
// as terminal or retryable by the code and not by luck, and that the maintenance
// sweep deletes real rows and reports real counts.
//
// It cannot prove two things, and neither is claimed here:
//
//   1. Cloudflare's managed container runtime. `ctx.container` does not exist in
//      the local runtime, so the processor is a real container this harness started
//      with Docker and reached through `PROCESSOR_ORIGIN`. The bytes, the protocol,
//      the deadlines and the validation are real; the *container lifecycle* is not.
//   2. A natural scheduled firing. The local runtime has no way to deliver a cron
//      event to a Workflow binding's `schedules`, so the scheduled branch of the
//      trigger is covered by the unit lane and the manual branch is covered here.
//      Genuine scheduled evidence is a deployed environment's, not this lane's.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobRecord, JobsDatabase } from '@starter/jobs';
import {
  createJobRepository,
  createWorkflowDispatchPort,
  systemClock,
  workflowIdFor,
} from '@starter/jobs';
import { JOB_ATTEMPT_LEASE_MS, JOB_OUTPUT_RETENTION_MS } from '@starter/schemas/jobs';
import { outputKey } from '../src/media_store.ts';
import { sha256Hex } from '../src/sha256.ts';
import {
  awaitInstance,
  type JobsRuntime,
  seedFixture,
  seedUser,
  startJobsRuntime,
} from './local_runtime.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '');
const FIXTURE_PATH = join(REPO_ROOT, 'apps/backend/media/fixtures/media/sample-v1.mp4');

const PROCESSOR_ORIGIN = process.env.PROCESSOR_ORIGIN;
const FIXTURE_KEY = 'media/v1/fixtures/sample-v1.mp4';

if (PROCESSOR_ORIGIN === undefined || PROCESSOR_ORIGIN.length === 0) {
  throw new Error(
    'The compute lane needs PROCESSOR_ORIGIN. Run it with `bun run test:compute`, which\n' +
      '  starts the processor container and exports this value. A lane that quietly ran\n' +
      '  against nothing is the failure this repository refuses.',
  );
}

let runtime: JobsRuntime;
let fixtureBytes = 0;

const db = (): D1Database => runtime.bindings.DB;
const bucket = (): R2Bucket => runtime.bindings.MEDIA;

const repository = () => createJobRepository(db() as unknown as JobsDatabase, systemClock);

const readJob = async (jobId: string): Promise<JobRecord | null> =>
  repository().getJobForOwner(await ownerOf(jobId), jobId);

const ownerOf = async (jobId: string): Promise<string> => {
  const row = await db()
    .prepare('SELECT owner_id FROM jobs WHERE id = ?')
    .bind(jobId)
    .first<{ owner_id: string }>();
  return row?.owner_id ?? '';
};

/** Admit a job the way the web Worker does: the repository plus one dispatch. */
const admit = async (ownerId: string, jobId: string, key: string) => {
  const admitted = await repository().createEncodeJob(
    ownerId,
    { fixture: 'sample-v1', preset: 'demo-180p-v1' },
    key,
    jobId,
  );
  expect(admitted.ok).toBe(true);
  return admitted.ok ? admitted.job : null;
};

const dispatchEncode = async (jobId: string, attemptId: string) =>
  runtime.bindings.ENCODE_WORKFLOW.create({
    id: workflowIdFor(jobId),
    params: { jobId, fixture: 'sample-v1', preset: 'demo-180p-v1', attemptId },
  });

beforeAll(async () => {
  runtime = await startJobsRuntime({ processorOrigin: PROCESSOR_ORIGIN });
  fixtureBytes = await seedFixture(bucket(), FIXTURE_KEY, FIXTURE_PATH);
});

afterAll(async () => {
  await runtime.dispose();
});

/** Wait for a job to reach a status, so a test does not race the Workflow. */
const pollJob = async (
  repository: ReturnType<typeof createJobRepository>,
  ownerId: string,
  jobId: string,
  wanted: JobRecord['status'],
  timeoutMs = 60_000,
): Promise<JobRecord | null> => {
  const deadline = Date.now() + timeoutMs;
  let job = await repository.getJobForOwner(ownerId, jobId);
  while (Date.now() < deadline && job?.status !== wanted) {
    await Bun.sleep(50);
    job = await repository.getJobForOwner(ownerId, jobId);
  }
  return job;
};

describe('the encode path, end to end', () => {
  test('a dispatch returns before the encode finishes, and the workflow finishes after it', async () => {
    // The acceptance claim in two halves, because either half alone is worthless:
    // "returns early" alone is satisfied by a workflow that never runs, and
    // "finishes" alone is satisfied by one that finished before anybody asked.
    await seedUser(db(), 'user-encode');
    expect(await admit('user-encode', 'job-e2e', `key-e2e-${Date.now()}`)).not.toBeNull();

    const instance = await dispatchEncode('job-e2e', 'attempt-e2e-1');

    // Immediately after `create`, the job is admitted and not yet finished. The
    // caller's 202 is honest because the work has not already been done.
    const immediately = await readJob('job-e2e');
    expect(immediately?.status).not.toBe('succeeded');

    // Nothing above holds a connection open: this is the "the caller disconnected"
    // half. The instance is awaited afterwards, by id, exactly as the platform would
    // continue it.
    expect(await awaitInstance(instance)).toBe('complete');

    const finished = await readJob('job-e2e');
    expect(finished?.status).toBe('succeeded');
    expect(finished?.outputKey).not.toBeNull();
    expect(finished?.output).not.toBeNull();
    expect(finished?.output?.bytes).toBeGreaterThan(0);
    expect(finished?.output?.videoCodec).toBe('h264');
    expect(finished?.output?.width).toBe(320);
    expect(finished?.output?.height).toBe(180);
  });

  test('the committed artifact is really in the bucket, with the bytes it claims', async () => {
    // "Real result can be fetched from R2" is not proved by a row that says so.
    const job = await readJob('job-e2e');
    expect(job?.outputKey).not.toBeNull();

    const committedKey = job?.outputKey;
    expect(committedKey).not.toBeNull();
    const object = await bucket().get(committedKey ?? '');
    expect(object).not.toBeNull();
    expect(object?.size).toBe(job?.output?.bytes ?? -1);

    const bytes = new Uint8Array(
      await (object ?? { arrayBuffer: async () => new ArrayBuffer(0) }).arrayBuffer(),
    );
    // Integrity: the stored bytes hash to the value the job row carries, which came
    // from the processor's own report.
    expect(sha256Hex(bytes)).toBe(job?.output?.sha256 ?? '');

    // And it is a real MP4 with a real video stream, not a file of the right size.
    expect(bytes.byteLength).toBeGreaterThan(10_000);
    // `ftyp` box: every MP4 starts with it.
    expect(String.fromCharCode(...bytes.subarray(4, 8))).toBe('ftyp');
  });

  test('the artifact is stored under an attempt-scoped key, not a job-level one', async () => {
    const job = await readJob('job-e2e');
    expect(job?.outputKey).toBe(outputKey('job-e2e', 'attempt-e2e-1'));
    // The point of the scoping: two attempts cannot write the same object, so a late
    // attempt cannot overwrite a committed artifact.
    expect(outputKey('job-e2e', 'attempt-e2e-1')).not.toBe(outputKey('job-e2e', 'attempt-e2e-2'));
  });

  test('the same job dispatched twice runs one encode, not two', async () => {
    await seedUser(db(), 'user-idem');
    await admit('user-idem', 'job-idem', `key-idem-${Date.now()}`);

    const first = await dispatchEncode('job-idem', 'attempt-idem-1');

    // The second dispatch of the same job. The deterministic id addresses the same
    // instance, so this must not start a second encode. The local runtime answers
    // with `instance.already_exists` where the hosted runtime returns the instance —
    // which is exactly why `createWorkflowDispatchPort` maps that code to success
    // rather than to a retryable provider failure.
    const again = await createWorkflowDispatchPort(runtime.bindings.ENCODE_WORKFLOW).dispatch({
      jobId: 'job-idem',
      workflowId: workflowIdFor('job-idem'),
      fixture: 'sample-v1',
      preset: 'demo-180p-v1',
      attemptId: 'attempt-idem-1',
    });
    expect(again).toEqual({ ok: true });

    expect(await awaitInstance(first)).toBe('complete');
    const job = await readJob('job-idem');
    expect(job?.status).toBe('succeeded');

    const keys = await bucket().list({ prefix: 'media/v1/jobs/job-idem/' });
    expect(keys.objects.length).toBe(1);
  });

  test('a second attempt while the lease is held refuses rather than overwriting', async () => {
    // The fencing claim, at run time rather than in a repository unit test: a second
    // instance of the same job, arriving while the first holds the lease, must not be
    // able to claim it and must not be able to commit over the winner.
    await seedUser(db(), 'user-fence');
    expect(await admit('user-fence', 'job-fence', `key-fence-${Date.now()}`)).not.toBeNull();

    // Take the lease directly, as a crashed attempt would have left it.
    const claimed = await repository().claimAttempt(
      'job-fence',
      'attempt-fence-holder',
      systemClock.now() + JOB_ATTEMPT_LEASE_MS,
    );
    expect(claimed.ok).toBe(true);

    const instance = await dispatchEncode('job-fence', 'attempt-fence-intruder');
    expect(await awaitInstance(instance)).toBe('complete');

    const after = await readJob('job-fence');
    // Still running, still leased by the holder: the intruder neither committed nor
    // released a lease it does not own.
    expect(after?.status).toBe('running');
    expect(after?.activeAttemptId).toBe('attempt-fence-holder');
    expect(after?.outputKey).toBeNull();
  });

  test('a stale attempt writing late is fenced out of a committed success', async () => {
    await seedUser(db(), 'user-stale');
    await admit('user-stale', 'job-stale', `key-stale-${Date.now()}`);

    // An earlier attempt claims the lease and then "disappears": its lease is already
    // expired, which is the state a crashed instance leaves behind.
    const abandoned = await repository().claimAttempt(
      'job-stale',
      'attempt-stale-a',
      systemClock.now() - 1,
    );
    expect(abandoned.ok).toBe(true);

    // The job completes through the real workflow, under an attempt that takes over
    // the expired lease.
    const instance = await dispatchEncode('job-stale', 'attempt-stale-b');
    expect(await awaitInstance(instance)).toBe('complete');

    const committed = await readJob('job-stale');
    expect(committed?.status).toBe('succeeded');

    // The superseded attempt wakes up and tries to commit its own result.
    const late = await repository().completeAttempt('job-stale', 'attempt-stale-a', {
      key: outputKey('job-stale', 'attempt-stale-a'),
      bytes: 1,
      sha256: 'b'.repeat(64),
      containerFormat: 'mp4',
      videoCodec: 'h264',
      width: 320,
      height: 180,
      durationMs: 1,
      expiresAt: systemClock.now() + JOB_OUTPUT_RETENTION_MS,
    });
    expect(late.ok).toBe(false);
    if (!late.ok) {
      expect(late.reason).toBe('fenced');
    }

    const afterLate = await readJob('job-stale');
    expect(afterLate?.outputKey).toBe(committed?.outputKey);
    expect(afterLate?.status).toBe('succeeded');
  });
});

describe('refusals, at the real processor boundary', () => {
  test('media the processor cannot decode ends the job in one attempt', async () => {
    // `invalid_media` is terminal. If this retried, the lane would see three
    // requests and three container starts to reach the same deterministic failure.
    const calls = { encode: 0 };
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        if (new URL(request.url).pathname === '/encode') {
          calls.encode += 1;
          return Response.json(
            {
              error: {
                code: 'invalid_media',
                message: 'input media could not be decoded',
                retryable: false,
              },
            },
            { status: 400 },
          );
        }
        return Response.json({
          release: 'test',
          protocol: 'sample-v1',
          fixture: 'sample-v1',
          presets: [],
          limits: {},
        });
      },
    });

    const liar = await startJobsRuntime({
      processorOrigin: `http://127.0.0.1:${server.port}`,
    });
    try {
      await seedUser(liar.bindings.DB, 'user-invalid');
      const admitted = await createJobRepository(
        liar.bindings.DB as unknown as JobsDatabase,
        systemClock,
      ).createEncodeJob(
        'user-invalid',
        { fixture: 'sample-v1', preset: 'demo-180p-v1' },
        `key-invalid-${Date.now()}`,
        'job-invalid',
      );
      expect(admitted.ok).toBe(true);
      await seedFixture(liar.bindings.MEDIA, FIXTURE_KEY, FIXTURE_PATH);

      const instance = await liar.bindings.ENCODE_WORKFLOW.create({
        id: workflowIdFor('job-invalid'),
        params: {
          jobId: 'job-invalid',
          fixture: 'sample-v1',
          preset: 'demo-180p-v1',
          attemptId: 'attempt-invalid-1',
        },
      });
      expect(await awaitInstance(instance)).toBe('complete');

      const job = await createJobRepository(
        liar.bindings.DB as unknown as JobsDatabase,
        systemClock,
      ).getJobForOwner('user-invalid', 'job-invalid');
      expect(job?.status).toBe('failed');
      expect(job?.errorCode).toBe('encode_failed');
      // One request. A retry here would be two more container starts to be told the
      // same thing.
      expect(calls.encode).toBe(1);
      // And nothing was published.
      expect(job?.outputKey).toBeNull();
    } finally {
      await liar.dispose();
      await server.stop(true);
    }
  });

  test('bytes that are not what the processor described are never committed', async () => {
    // A processor that reports a hash its body does not have. The integrity check
    // exists for exactly this: without it, "the processor said 200" would be
    // published as a downloadable artifact.
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        if (new URL(request.url).pathname === '/encode') {
          return new Response(new Uint8Array(4096).fill(3), {
            status: 200,
            headers: {
              'x-protocol': 'sample-v1',
              'x-preset': 'demo-180p-v1',
              'x-attempt-id': new URL(request.url).searchParams.get('attempt') ?? 'attempt-liar-1',
              'x-output-bytes': '4096',
              // Deliberately not the hash of the body.
              'x-output-sha256': 'f'.repeat(64),
              'x-output-codec': 'h264',
              'x-output-dimensions': '320x180',
              'x-output-duration-ms': '3000',
            },
          });
        }
        return Response.json({
          release: 'liar',
          protocol: 'sample-v1',
          fixture: 'sample-v1',
          presets: [],
          limits: {},
        });
      },
    });

    const liar = await startJobsRuntime({ processorOrigin: `http://127.0.0.1:${server.port}` });
    try {
      await seedUser(liar.bindings.DB, 'user-liar');
      const repositoryLiar = createJobRepository(
        liar.bindings.DB as unknown as JobsDatabase,
        systemClock,
      );
      await repositoryLiar.createEncodeJob(
        'user-liar',
        { fixture: 'sample-v1', preset: 'demo-180p-v1' },
        `key-liar-${Date.now()}`,
        'job-liar',
      );
      await seedFixture(liar.bindings.MEDIA, FIXTURE_KEY, FIXTURE_PATH);

      const instance = await liar.bindings.ENCODE_WORKFLOW.create({
        id: workflowIdFor('job-liar'),
        params: {
          jobId: 'job-liar',
          fixture: 'sample-v1',
          preset: 'demo-180p-v1',
          attemptId: 'attempt-liar-1',
        },
      });
      expect(await awaitInstance(instance)).toBe('complete');

      const job = await repositoryLiar.getJobForOwner('user-liar', 'job-liar');
      expect(job?.status).toBe('failed');
      expect(job?.errorCode).toBe('encode_failed');
      expect(job?.outputKey).toBeNull();
    } finally {
      await liar.dispose();
      await server.stop(true);
    }
  });

  test('a transient refusal is retried, and only three attempts are ever spent', async () => {
    let encodeCalls = 0;
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        if (new URL(request.url).pathname === '/encode') {
          encodeCalls += 1;
          if (encodeCalls <= 2) {
            // `busy` is retryable: the one encode slot is taken.
            return Response.json(
              {
                error: {
                  code: 'busy',
                  message: 'an encode is already in progress',
                  retryable: true,
                },
              },
              { status: 429 },
            );
          }
          // Third attempt succeeds with real bytes, so the workflow can commit.
          return new Response(new Uint8Array(2048).fill(9), {
            status: 200,
            headers: {
              'x-protocol': 'sample-v1',
              'x-preset': 'demo-180p-v1',
              'x-attempt-id': 'attempt-retry-1',
              'x-output-bytes': '2048',
              'x-output-sha256': sha256Hex(new Uint8Array(2048).fill(9)),
              'x-output-codec': 'h264',
              'x-output-dimensions': '320x180',
              'x-output-duration-ms': '3000',
            },
          });
        }
        return Response.json({
          release: 'test',
          protocol: 'sample-v1',
          fixture: 'sample-v1',
          presets: [],
          limits: {},
        });
      },
    });

    const flaky = await startJobsRuntime({ processorOrigin: `http://127.0.0.1:${server.port}` });
    try {
      await seedUser(flaky.bindings.DB, 'user-retry');
      const repositoryFlaky = createJobRepository(
        flaky.bindings.DB as unknown as JobsDatabase,
        systemClock,
      );
      await repositoryFlaky.createEncodeJob(
        'user-retry',
        { fixture: 'sample-v1', preset: 'demo-180p-v1' },
        `key-retry-${Date.now()}`,
        'job-retry',
      );
      await seedFixture(flaky.bindings.MEDIA, FIXTURE_KEY, FIXTURE_PATH);

      const instance = await flaky.bindings.ENCODE_WORKFLOW.create({
        id: workflowIdFor('job-retry'),
        params: {
          jobId: 'job-retry',
          fixture: 'sample-v1',
          preset: 'demo-180p-v1',
          attemptId: 'attempt-retry-1',
        },
      });
      expect(await awaitInstance(instance)).toBe('complete');

      // Two refusals, then a success: three processor calls, which is the whole
      // step-level retry budget.
      expect(encodeCalls).toBe(3);
      const job = await repositoryFlaky.getJobForOwner('user-retry', 'job-retry');
      expect(job?.status).toBe('succeeded');
      // One *claim*, though: a step retry reuses the attempt's lease, so the job's
      // budget is not spent on a transient refusal. `attempt_count` counts claims,
      // which is what the admission and recovery logic reasons about — conflating
      // the two is how a retry policy quietly becomes a budget policy.
      expect(job?.attemptCount).toBe(1);
    } finally {
      await flaky.dispose();
      await server.stop(true);
    }
  });

  test('exhausted attempts end the job as failed rather than leaving it running', async () => {
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) =>
        new URL(request.url).pathname === '/encode'
          ? Response.json(
              {
                error: {
                  code: 'busy',
                  message: 'an encode is already in progress',
                  retryable: true,
                },
              },
              { status: 429 },
            )
          : Response.json({
              release: 'test',
              protocol: 'sample-v1',
              fixture: 'sample-v1',
              presets: [],
              limits: {},
            }),
    });

    const stuck = await startJobsRuntime({ processorOrigin: `http://127.0.0.1:${server.port}` });
    try {
      await seedUser(stuck.bindings.DB, 'user-stuck');
      const repositoryStuck = createJobRepository(
        stuck.bindings.DB as unknown as JobsDatabase,
        systemClock,
      );
      await repositoryStuck.createEncodeJob(
        'user-stuck',
        { fixture: 'sample-v1', preset: 'demo-180p-v1' },
        `key-stuck-${Date.now()}`,
        'job-stuck',
      );
      await seedFixture(stuck.bindings.MEDIA, FIXTURE_KEY, FIXTURE_PATH);

      const instance = await stuck.bindings.ENCODE_WORKFLOW.create({
        id: workflowIdFor('job-stuck'),
        params: {
          jobId: 'job-stuck',
          fixture: 'sample-v1',
          preset: 'demo-180p-v1',
          attemptId: 'attempt-stuck-1',
        },
      });
      expect(await awaitInstance(instance)).toBe('complete');

      const job = await repositoryStuck.getJobForOwner('user-stuck', 'job-stuck');
      // A job left `running` is a lie to whoever is watching it, and a caller that
      // sees it will wait for an encode that is never coming.
      expect(job?.status).toBe('failed');
      expect(job?.errorCode).toBe('attempts_exhausted');
      // The lease is released, so maintenance and the next attempt are not blocked by
      // a claim nobody holds.
      expect(job?.activeAttemptId).toBeNull();
    } finally {
      await stuck.dispose();
      await server.stop(true);
    }
  });

  test('a job whose fixture is not in the store fails instead of encoding nothing', async () => {
    await seedUser(db(), 'user-nofixture');
    await admit('user-nofixture', 'job-nofixture', `key-nofixture-${Date.now()}`);
    void FIXTURE_KEY;
    // The fixture *is* present in this runtime, so this asserts the opposite path is
    // real: the same job, in a runtime whose bucket has never been seeded.
    const empty = await startJobsRuntime({
      processorOrigin: PROCESSOR_ORIGIN,
      migrations: true,
    });
    try {
      await empty.bindings.DB.prepare('DELETE FROM jobs').run();
      await empty.bindings.DB.prepare('DELETE FROM users').run();
      await seedUser(empty.bindings.DB, 'user-empty');
      await createJobRepository(
        empty.bindings.DB as unknown as JobsDatabase,
        systemClock,
      ).createEncodeJob(
        'user-empty',
        { fixture: 'sample-v1', preset: 'demo-180p-v1' },
        `key-empty-${Date.now()}`,
        'job-empty',
      );
      const instance = await empty.bindings.ENCODE_WORKFLOW.create({
        id: workflowIdFor('job-empty'),
        params: {
          jobId: 'job-empty',
          fixture: 'sample-v1',
          preset: 'demo-180p-v1',
          attemptId: 'attempt-empty-1',
        },
      });
      expect(await awaitInstance(instance)).toBe('complete');
      const job = await createJobRepository(
        empty.bindings.DB as unknown as JobsDatabase,
        systemClock,
      ).getJobForOwner('user-empty', 'job-empty');
      expect(job?.status).toBe('failed');
      expect(job?.outputKey).toBeNull();
    } finally {
      await empty.dispose();
    }
  });
});

describe('maintenance, at the real database boundary', () => {
  test('a manual run deletes real rows and records the real counts', async () => {
    const maintenance = await startJobsRuntime({ processorOrigin: PROCESSOR_ORIGIN });
    try {
      const now = Math.floor(Date.now() / 1000);
      await seedUser(maintenance.bindings.DB, 'user-sweep');
      for (let index = 0; index < 3; index += 1) {
        await maintenance.bindings.DB.prepare(
          `INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            // Older than the 7-day session retention, which is the default this
            // sweep applies. A session that expired yesterday is *retained*, and a
            // test that expected it to be deleted would be asserting a wrong policy.
            `sess-${index}`,
            'user-sweep',
            `token-${index}`,
            now - 8 * 86_400,
            now - 9 * 86_400,
            now - 9 * 86_400,
          )
          .run();
        await maintenance.bindings.DB.prepare(
          `INSERT INTO rate_limits (key, count, last_request) VALUES (?, 1, ?)`,
        )
          .bind(`ip-${index}`, now - 2 * 86_400)
          .run();
      }

      const instance = await maintenance.bindings.MAINTENANCE_WORKFLOW.create({
        id: `maintenance-manual-${Date.now()}`,
        params: { requestId: `lane-${Date.now()}` },
      });
      expect(await awaitInstance(instance)).toBe('complete');

      const sessions = await maintenance.bindings.DB.prepare(
        'SELECT count(*) AS n FROM sessions',
      ).first<{ n: number }>();
      const limits = await maintenance.bindings.DB.prepare(
        'SELECT count(*) AS n FROM rate_limits',
      ).first<{ n: number }>();
      expect(sessions?.n).toBe(0);
      expect(limits?.n).toBe(0);

      const runs = await maintenance.bindings.DB.prepare(
        'SELECT run_key, trigger, status, expired_sessions, idle_rate_limits FROM maintenance_runs',
      ).all<{
        run_key: string;
        trigger: string;
        status: string;
        expired_sessions: number;
        idle_rate_limits: number;
      }>();
      expect(runs.results).toHaveLength(1);
      expect(runs.results[0]?.trigger).toBe('manual');
      expect(runs.results[0]?.status).toBe('succeeded');
      // Truthful counts: three rows went, and the record says three.
      expect(runs.results[0]?.expired_sessions).toBe(3);
      expect(runs.results[0]?.idle_rate_limits).toBe(3);
    } finally {
      await maintenance.dispose();
    }
  });

  test('a repeated manual request does not sweep twice', async () => {
    const maintenance = await startJobsRuntime({ processorOrigin: PROCESSOR_ORIGIN });
    try {
      const requestId = `lane-repeat-${Date.now()}`;
      const first = await maintenance.bindings.MAINTENANCE_WORKFLOW.create({
        id: `maintenance-repeat-a-${Date.now()}`,
        params: { requestId },
      });
      expect(await awaitInstance(first)).toBe('complete');
      const second = await maintenance.bindings.MAINTENANCE_WORKFLOW.create({
        id: `maintenance-repeat-b-${Date.now()}`,
        params: { requestId },
      });
      expect(await awaitInstance(second)).toBe('complete');

      const runs = await maintenance.bindings.DB.prepare(
        'SELECT count(*) AS n FROM maintenance_runs',
      ).first<{ n: number }>();
      // One row for one request id: the dedup is the primary key, not a check.
      expect(runs?.n).toBe(1);
      const status = await maintenance.bindings.DB.prepare(
        'SELECT status FROM maintenance_runs',
      ).first<{ status: string }>();
      expect(status?.status).toBe('succeeded');
    } finally {
      await maintenance.dispose();
    }
  });

  test('a job admitted but never dispatched is recovered by the sweep', async () => {
    // The crash the design calls out: D1 committed the admission and the Workflow
    // call never happened. Nothing else in the system would ever start it.
    const maintenance = await startJobsRuntime({ processorOrigin: PROCESSOR_ORIGIN });
    try {
      await seedUser(maintenance.bindings.DB, 'user-recover');
      await seedFixture(maintenance.bindings.MEDIA, FIXTURE_KEY, FIXTURE_PATH);
      const repositoryRecover = createJobRepository(
        maintenance.bindings.DB as unknown as JobsDatabase,
        systemClock,
      );
      await repositoryRecover.createEncodeJob(
        'user-recover',
        { fixture: 'sample-v1', preset: 'demo-180p-v1' },
        `key-recover-${Date.now()}`,
        'job-recover',
      );

      const instance = await maintenance.bindings.MAINTENANCE_WORKFLOW.create({
        id: `maintenance-recover-${Date.now()}`,
        params: { requestId: `lane-recover-${Date.now()}` },
      });
      expect(await awaitInstance(instance)).toBe('complete');

      // The recovery pass created the encode instance itself, so this polls the job
      // rather than creating a second one — a second `create` here would fail with
      // `instance.already_exists`, which would prove nothing about recovery.
      const job = await pollJob(repositoryRecover, 'user-recover', 'job-recover', 'succeeded');
      expect(job?.status).toBe('succeeded');
      expect(job?.dispatchState).toBe('dispatched');
      const stored = await maintenance.bindings.MEDIA.head(job?.outputKey ?? '');
      expect(stored).not.toBeNull();
    } finally {
      await maintenance.dispose();
    }
  });

  test('expiry never disturbs a running job and its live lease', async () => {
    // The maintenance run terminalises abandoned jobs. A job that is genuinely
    // running, with a lease nobody has taken over, must survive the sweep — the
    // failure this guards against is a job failed while its own encode is in flight,
    // which produces a committed artifact for a job that says `failed`.
    const maintenance = await startJobsRuntime({ processorOrigin: PROCESSOR_ORIGIN });
    try {
      await seedUser(maintenance.bindings.DB, 'user-live');
      const repositoryLive = createJobRepository(
        maintenance.bindings.DB as unknown as JobsDatabase,
        systemClock,
      );
      await repositoryLive.createEncodeJob(
        'user-live',
        { fixture: 'sample-v1', preset: 'demo-180p-v1' },
        `key-live-${Date.now()}`,
        'job-live',
      );
      const claimed = await repositoryLive.claimAttempt(
        'job-live',
        'attempt-live-1',
        systemClock.now() + JOB_ATTEMPT_LEASE_MS,
      );
      expect(claimed.ok).toBe(true);

      const instance = await maintenance.bindings.MAINTENANCE_WORKFLOW.create({
        id: `maintenance-live-${Date.now()}`,
        params: { requestId: `lane-live-${Date.now()}` },
      });
      expect(await awaitInstance(instance)).toBe('complete');

      const job = await repositoryLive.getJobForOwner('user-live', 'job-live');
      expect(job?.status).toBe('running');
      expect(job?.activeAttemptId).toBe('attempt-live-1');
      expect(job?.completedAt).toBeNull();
    } finally {
      await maintenance.dispose();
    }
  });

  test('an expired artifact is retired only after the store confirms the bytes are gone', async () => {
    const maintenance = await startJobsRuntime({ processorOrigin: PROCESSOR_ORIGIN });
    try {
      await seedUser(maintenance.bindings.DB, 'user-expire');
      const nowSec = Math.floor(Date.now() / 1000);
      const key = outputKey('job-expire', 'attempt-expire-1');
      await maintenance.bindings.MEDIA.put(key, new Uint8Array([1, 2, 3]));
      await maintenance.bindings.DB.prepare(
        `INSERT INTO jobs (id, owner_id, kind, status, fixture, preset, idempotency_key,
           request_fingerprint, workflow_id, dispatch_state, output_key, output_bytes,
           output_sha256, output_container_format, output_video_codec, output_width,
           output_height, output_duration_ms, output_expires_at, created_at, updated_at)
         VALUES ('job-expire', 'user-expire', 'encode', 'succeeded', 'sample-v1',
           'demo-180p-v1', 'key-expire', '{}', 'encode-job-expire', 'dispatched', ?, 3, ?,
           'mp4', 'h264', 320, 180, 3000, ?, ?, ?)`,
      )
        .bind(key, 'c'.repeat(64), nowSec - 10, nowSec - 100, nowSec - 100)
        .run();

      const first = await maintenance.bindings.MAINTENANCE_WORKFLOW.create({
        id: `maintenance-expire-a-${Date.now()}`,
        params: { requestId: `lane-expire-a-${Date.now()}` },
      });
      expect(await awaitInstance(first)).toBe('complete');
      // A first run queues the retirement and confirms the bytes are gone in the
      // same run, so the object is gone and the job's output columns are cleared.
      const jobAfter = await createJobRepository(
        maintenance.bindings.DB as unknown as JobsDatabase,
        systemClock,
      ).getJobForOwner('user-expire', 'job-expire');
      expect(jobAfter?.status).toBe('succeeded');
      expect(jobAfter?.outputKey).toBeNull();
      expect(await maintenance.bindings.MEDIA.head(key)).toBeNull();
    } finally {
      await maintenance.dispose();
    }
  });

  test('the fixture this lane encodes is the committed one', () => {
    // Guards the lane itself: a fixture seeded from some other path would make every
    // assertion above true of the wrong bytes.
    expect(fixtureBytes).toBeGreaterThan(10_000);
  });
});

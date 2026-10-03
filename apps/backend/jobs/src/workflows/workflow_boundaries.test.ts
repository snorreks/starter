import { expect, mock, test } from 'bun:test';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { JobsEnv } from '../env.ts';

// Only the platform base class is substituted. Workflow decisions and repository
// writes execute normally; step failures are injected without provider retry delays.
mock.module('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {},
  DurableObject: class {},
}));
const { EncodeWorkflow } = await import('./encode_workflow.ts');
const { MaintenanceWorkflow } = await import('./maintenance_workflow.ts');

const params = {
  requestId: 'boundary',
  jobId: 'job-boundary',
  attemptId: 'attempt-boundary',
  fixture: 'sample-v1' as const,
  preset: 'demo-180p-v1' as const,
};
const event = { payload: params, instanceId: 'boundary' } as WorkflowEvent<typeof params>;
const report = {
  cutoffAt: 0,
  expiredSessions: 0,
  idleRateLimits: 0,
  artifactsQueued: 0,
  artifactsRetired: 0,
  pendingDispatches: 0,
};

const environment = () => {
  const writes: unknown[][] = [];
  const deleted: string[] = [];
  const env = {
    DEPLOYMENT_ENV: 'local',
    JOBS_PROFILE: 'encode',
    DB: {
      prepare: () => ({
        bind: (...values: unknown[]) => ({
          run: async () => {
            writes.push(values);
            return { meta: { changes: 1 } };
          },
          all: async () => ({ results: [] }),
        }),
      }),
    },
    MEDIA: {
      delete: async (key: string) => {
        deleted.push(key);
      },
      head: async () => null,
    },
    CONTAINER: { idFromName: () => 'id', get: () => ({ fetch: async () => new Response() }) },
    ENCODE_WORKFLOW: {
      create: async () => {
        throw new Error('unexpected dispatch');
      },
    },
    MAINTENANCE_WORKFLOW: {},
  } as unknown as JobsEnv;
  return { env, writes, deleted };
};

const workflow = <T extends object>(prototype: T, env: JobsEnv): T =>
  Object.assign(Object.create(prototype), { env }) as T;
const steps = (run: (name: string, callback: () => Promise<unknown>) => Promise<unknown>) =>
  ({
    do: (name: string, ...args: unknown[]) => run(name, args.at(-1) as () => Promise<unknown>),
  }) as unknown as WorkflowStep;

test('workflow entries reject missing bindings and invalid deployment mode before any step', async () => {
  for (const prototype of [EncodeWorkflow.prototype, MaintenanceWorkflow.prototype]) {
    for (const overrides of [
      { DB: undefined },
      { DEPLOYMENT_ENV: undefined },
      { DEPLOYMENT_ENV: 'typo' },
    ]) {
      const { env } = environment();
      const entry = workflow(prototype, { ...env, ...overrides } as JobsEnv);
      let calls = 0;
      await expect(
        entry.run(
          event,
          steps(async () => {
            calls += 1;
          }),
        ),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    }
  }
});

test('disabled or invalid encoding profiles never claim an encode', async () => {
  for (const profile of [undefined, 'disabled', 'typo']) {
    const { env } = environment();
    const entry = workflow(EncodeWorkflow.prototype, { ...env, JOBS_PROFILE: profile });
    let calls = 0;
    const result = entry.run(
      event,
      steps(async () => {
        calls += 1;
      }),
    );
    if (profile === 'typo') {
      await expect(result).rejects.toThrow('JOBS_PROFILE');
    } else {
      expect(await result).toMatchObject({ outcome: 'compute_profile_disabled' });
    }
    expect(calls).toBe(0);
  }
});

test('disabled encoding still permits maintenance cleanup and completion', async () => {
  const { env, writes } = environment();
  const visited: string[] = [];
  const result = await workflow(MaintenanceWorkflow.prototype, {
    ...env,
    JOBS_PROFILE: 'disabled',
  }).run(
    event,
    steps(async (name, callback) => {
      visited.push(name);
      if (name === 'claim') {
        return { claimed: true, runKey: 'manual:boundary', tookOver: false };
      }
      if (name === 'sweep') {
        return { ok: true, report };
      }
      return callback();
    }),
  );
  expect(result.outcome).toBe('succeeded');
  expect(visited).toContain('delete-expired-bytes');
  expect(visited).toContain('recover-dispatches');
  expect(writes).toHaveLength(1);
});

test('byte deletion and dispatch recovery errors record a failed run before propagating', async () => {
  for (const failingStep of ['delete-expired-bytes', 'recover-dispatches']) {
    const { env, writes } = environment();
    const failure = new Error('step failed');
    await expect(
      workflow(MaintenanceWorkflow.prototype, env).run(
        event,
        steps(async (name, callback) => {
          if (name === 'claim') {
            return { claimed: true, runKey: 'manual:boundary', tookOver: false };
          }
          if (name === 'sweep') {
            return { ok: true, report };
          }
          if (name === failingStep) {
            throw failure;
          }
          return callback();
        }),
      ),
    ).rejects.toBe(failure);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('dispatch_recovery_failed');
    expect(writes[0]).toContain('manual:boundary');
  }
});

test('unverified or fenced commit output is deleted using the encoded key', async () => {
  for (const outcome of ['missing_output', 'size_mismatch', 'fenced']) {
    const { env, deleted } = environment();
    const key = 'media/v1/jobs/job-boundary/attempts/attempt-boundary.mp4';
    const media = env.MEDIA as unknown as { head: () => Promise<unknown> };
    media.head = async () =>
      outcome === 'missing_output' ? null : { size: outcome === 'size_mismatch' ? 2 : 1 };
    if (outcome === 'fenced') {
      env.DB.prepare = (() => ({
        bind: () => ({ all: async () => ({ results: [] }), first: async () => null }),
      })) as unknown as D1Database['prepare'];
    }
    const result = await workflow(EncodeWorkflow.prototype, env).run(
      event,
      steps(async (name, callback) => {
        if (name === 'admit') {
          return { outcome: 'claimed', status: 'running' };
        }
        if (name === 'encode') {
          return {
            ok: true,
            artifact: {
              key,
              bytes: 1,
              sha256: '0'.repeat(64),
              videoCodec: 'h264',
              width: 320,
              height: 180,
              durationMs: 3000,
            },
          };
        }
        if (name === 'fail-unverified-output') {
          return true;
        }
        return callback();
      }),
    );
    expect(result.outcome).toBe(outcome);
    expect(deleted).toEqual([key]);
  }
});

const { EncodeContainer } = await import('../encode_container.ts');

test('the container validates its origin without requiring Workflow bindings', async () => {
  for (const origin of ['not-a-url', 'ftp://processor', 'http://processor/path']) {
    const container = Object.assign(Object.create(EncodeContainer.prototype), {
      env: { PROCESSOR_ORIGIN: origin },
      ctx: {},
    }) as InstanceType<typeof EncodeContainer>;
    await expect(container.fetch(new Request('http://container/health'))).rejects.toThrow(
      'PROCESSOR_ORIGIN',
    );
  }
});

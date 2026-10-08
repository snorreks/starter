import { expect, mock, test } from 'bun:test';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { JobsEnv } from '../env.ts';
import type { EncodeWorkflowParams } from './encode_workflow.ts';
import type { MaintenanceWorkflowParams } from './maintenance_workflow.ts';

mock.module('cloudflare:workers', () => ({
  WorkflowEntrypoint: class {},
  env: { DEPLOYMENT_ENV: 'local' },
}));
const { EncodeWorkflow } = await import('./encode_workflow.ts');
const { MaintenanceWorkflow } = await import('./maintenance_workflow.ts');

const event = {
  payload: {
    jobId: 'job-boundary',
    fixture: 'sample-v1',
    preset: 'demo-180p-v1',
    attemptId: 'attempt-boundary',
  },
} as WorkflowEvent<EncodeWorkflowParams>;
const workflow = <T extends object>(prototype: T, env: JobsEnv): T =>
  Object.assign(Object.create(prototype), { env }) as T;
const steps = (run: (callback: () => Promise<unknown>) => Promise<unknown>) =>
  ({
    do: (_name: string, ...args: unknown[]) => run(args.at(-1) as () => Promise<unknown>),
  }) as WorkflowStep;

test('missing jobs profile refuses before running a workflow step', async () => {
  const entry = workflow(EncodeWorkflow.prototype, { DEPLOYMENT_ENV: 'local' });
  let calls = 0;
  await expect(
    entry.run(
      event,
      steps(async () => {
        calls += 1;
      }),
    ),
  ).rejects.toThrow('JOBS_PROFILE');
  expect(calls).toBe(0);
});

test.each(['disabled', ' disabled \n'])(
  'disabled profile %j never starts workflow steps',
  async (profile) => {
    const env = { DEPLOYMENT_ENV: 'local', JOBS_PROFILE: profile } as JobsEnv;
    const noSteps = steps(async () => {
      throw new Error('Disabled workflow started a step');
    });
    const encode = await workflow(EncodeWorkflow.prototype, env).run(event, noSteps);
    const maintenanceEvent = { payload: {} } as WorkflowEvent<MaintenanceWorkflowParams>;
    const maintenance = await workflow(MaintenanceWorkflow.prototype, env).run(
      maintenanceEvent,
      noSteps,
    );
    expect(encode).toMatchObject({ outcome: 'compute_profile_disabled' });
    expect(maintenance).toMatchObject({ outcome: 'compute_profile_disabled' });
  },
);

test('enabled compute refuses when Cloud Run prerequisites are missing', async () => {
  const entry = workflow(EncodeWorkflow.prototype, {
    DEPLOYMENT_ENV: 'local',
    JOBS_PROFILE: 'encode',
  } as JobsEnv);
  await expect(
    entry.run(
      event,
      steps(async () => null),
    ),
  ).rejects.toThrow('Cloud Run compute configuration is incomplete');
});

const enabledEnv = (status: string): JobsEnv => ({
  DEPLOYMENT_ENV: 'local',
  JOBS_PROFILE: 'encode',
  SUPABASE_URL: 'https://supabase.invalid',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  MEDIA: {} as R2Bucket,
  ENCODE_WORKFLOW: {
    create: async () => ({ id: 'encode' }),
    get: async () => ({ status: async () => ({ status }) }),
  },
  MAINTENANCE_WORKFLOW: {
    create: async () => {
      throw new Error('already_exists');
    },
    get: async () => ({ status: async () => ({ status }) }),
  },
  GOOGLE_CLOUD_PROJECT: 'project',
  GOOGLE_CLOUD_REGION: 'region',
  GOOGLE_CLOUD_RUN_JOB: 'job',
  GOOGLE_RUNNER_SERVICE_ACCOUNT: 'account',
  GOOGLE_RUNNER_SUBJECT: 'subject',
  GOOGLE_RUNNER_AUDIENCE: 'audience',
  GOOGLE_DISPATCHER_CREDENTIAL: 'fixture',
  COMPUTE_PROTOCOL: 'sample-v1',
});

test('retention work cannot be replayed by automatic workflow retries', async () => {
  const doStep = mock(async () => ({ outcome: 'artifact_retention' }));
  await workflow(MaintenanceWorkflow.prototype, enabledEnv('running')).run(
    { payload: {} } as WorkflowEvent<MaintenanceWorkflowParams>,
    { do: doStep } as unknown as WorkflowStep,
  );
  expect(doStep).toHaveBeenCalledWith(
    'supabase-r2-artifact-retention',
    expect.objectContaining({ retries: expect.objectContaining({ limit: 0 }) }),
    expect.any(Function),
  );
});

const { default: handler } = await import('../index.ts');
const controller = { scheduledTime: 0 } as ScheduledController;
test.each(['queued', 'running', 'waiting', 'paused', 'waitingForPause', 'complete'])(
  'duplicate scheduled maintenance accepts %s',
  async (status) => {
    await handler.scheduled(controller, enabledEnv(status));
  },
);
test.each(['completed', 'errored', 'terminated', 'unknown', ''])(
  'duplicate scheduled maintenance refuses %s',
  async (status) => {
    await expect(handler.scheduled(controller, enabledEnv(status))).rejects.toThrow(
      'unexpected state',
    );
  },
);
test('duplicate scheduled maintenance refuses a missing state', async () => {
  const env: JobsEnv = {
    ...enabledEnv('running'),
    MAINTENANCE_WORKFLOW: {
      create: async () => {
        throw new Error('already_exists');
      },
      get: async () => ({ status: async () => undefined }) as never,
    },
  };
  await expect(handler.scheduled(controller, env)).rejects.toThrow('unexpected state');
});

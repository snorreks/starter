import { expect, mock, test } from 'bun:test';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { JobsEnv } from '../env.ts';
import type { EncodeWorkflowParams } from './encode_workflow.ts';
import type { MaintenanceWorkflowParams } from './maintenance_workflow.ts';

mock.module('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));
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

test('explicitly disabled compute reports that encode work is unavailable', async () => {
  const env = { DEPLOYMENT_ENV: 'local', JOBS_PROFILE: 'disabled' } as JobsEnv;
  const encode = await workflow(EncodeWorkflow.prototype, env).run(
    event,
    steps(async () => null),
  );
  const maintenanceEvent = { payload: {} } as WorkflowEvent<MaintenanceWorkflowParams>;
  const maintenance = await workflow(MaintenanceWorkflow.prototype, env).run(
    maintenanceEvent,
    steps(async () => null),
  );
  expect(encode).toMatchObject({ outcome: 'compute_profile_disabled' });
  expect(maintenance).toMatchObject({ outcome: 'compute_profile_disabled' });
});

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

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { MAX_JOB_ATTEMPTS } from '@starter/schemas/jobs';
import { createId } from '@starter/utils';
import { runCloudRunAttempt } from '../cloud_run/compute.ts';
import {
  type JobsEnv,
  requireJobsBindings,
  requireJobsDeploymentEnvironment,
  resolveJobsProfile,
} from '../env.ts';

export interface EncodeWorkflowParams {
  jobId: string;
  fixture: 'sample-v1';
  preset: 'demo-180p-v1';
  attemptId: string;
}

export class EncodeWorkflow extends WorkflowEntrypoint<JobsEnv, EncodeWorkflowParams> {
  override async run(event: WorkflowEvent<EncodeWorkflowParams>, step: WorkflowStep) {
    const env = requireJobsBindings(this.env);
    requireJobsDeploymentEnvironment(env);
    const profile = resolveJobsProfile(env);
    if (profile.ok && profile.profile === 'disabled') {
      return { jobId: event.payload.jobId, outcome: 'compute_profile_disabled' as const };
    }
    for (let number = 0; number < MAX_JOB_ATTEMPTS; number += 1) {
      const result = await step.do(
        `cloud-run-${number + 1}`,
        { retries: { limit: 0, delay: 1000, backoff: 'constant' }, timeout: 20 * 60 * 1000 },
        async () => {
          const attemptId = number === 0 ? event.payload.attemptId : createId('attempt');
          const outcome = await runCloudRunAttempt(env, { jobId: event.payload.jobId, attemptId });
          return { attemptId, outcome: outcome.outcome };
        },
      );
      if (['committed', 'fenced', 'terminal_failure'].includes(result.outcome)) {
        return result;
      }
    }
    return { jobId: event.payload.jobId, outcome: 'attempts_exhausted' as const };
  }
}

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { runSupabaseArtifactRetention } from '../cloud_run/maintenance.ts';
import { type JobsEnv, requireJobsBindings, requireJobsDeploymentEnvironment } from '../env.ts';

export interface MaintenanceWorkflowParams {
  runKey: string;
  trigger: 'scheduled' | 'manual';
  slot: string | null;
  scheduledTime: string | null;
}
export class MaintenanceWorkflow extends WorkflowEntrypoint<JobsEnv, MaintenanceWorkflowParams> {
  override async run(event: WorkflowEvent<MaintenanceWorkflowParams>, step: WorkflowStep) {
    const env = requireJobsBindings(this.env);
    requireJobsDeploymentEnvironment(env);
    if (env.JOBS_PROFILE === 'disabled') {
      return { outcome: 'compute_profile_disabled' as const };
    }
    return step.do('supabase-r2-artifact-retention', async () => ({
      outcome: 'artifact_retention' as const,
      ...(await runSupabaseArtifactRetention(env, event.payload)),
      historyRetention: 'supabase_cron' as const,
    }));
  }
}

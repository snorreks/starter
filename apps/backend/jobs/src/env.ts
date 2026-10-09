import type { WorkflowInstanceBinding } from '@starter/jobs';

export const JOBS_PROFILE_DISABLED = 'disabled';
export const JOBS_PROFILE_ENCODE = 'encode';
export const JOBS_PROFILE_NAMES = [JOBS_PROFILE_DISABLED, JOBS_PROFILE_ENCODE] as const;
export type JobsProfileName = (typeof JOBS_PROFILE_NAMES)[number];

export interface JobsEnv {
  readonly MEDIA?: R2Bucket;
  readonly ENCODE_WORKFLOW?: WorkflowInstanceBinding;
  readonly MAINTENANCE_WORKFLOW?: WorkflowInstanceBinding;
  readonly SUPABASE_URL?: string;
  readonly SUPABASE_ANON_KEY?: string;
  readonly SUPABASE_SERVICE_ROLE_KEY?: string;
  readonly GOOGLE_CLOUD_PROJECT?: string;
  readonly GOOGLE_CLOUD_REGION?: string;
  readonly GOOGLE_CLOUD_RUN_JOB?: string;
  readonly GOOGLE_RUNNER_SERVICE_ACCOUNT?: string;
  readonly GOOGLE_RUNNER_SUBJECT?: string;
  readonly GOOGLE_RUNNER_AUDIENCE?: string;
  readonly GOOGLE_DISPATCHER_CREDENTIAL?: string;
  readonly COMPUTE_PROTOCOL?: string;
  readonly DEPLOYMENT_ENV?: string;
  readonly JOBS_PROFILE?: string;
  readonly RELEASE?: string;
}

export type ProfileResolution =
  | { ok: true; profile: JobsProfileName }
  | { ok: false; problem: string; remedy: string };

export const resolveJobsProfile = (env: { JOBS_PROFILE?: string }): ProfileResolution => {
  const raw = env.JOBS_PROFILE?.trim();
  if (raw === undefined || raw.length === 0) {
    return {
      ok: false,
      problem: 'JOBS_PROFILE is not set.',
      remedy: 'Set JOBS_PROFILE=disabled or encode explicitly.',
    };
  }
  if (raw !== JOBS_PROFILE_DISABLED && raw !== JOBS_PROFILE_ENCODE) {
    return {
      ok: false,
      problem: `JOBS_PROFILE is "${raw}", not disabled or encode.`,
      remedy: 'Set an explicit supported compute capability.',
    };
  }
  return { ok: true, profile: raw };
};

export const requireJobsDeploymentEnvironment = (env: { DEPLOYMENT_ENV?: string }): void => {
  if (
    !['local', 'development', 'staging', 'production'].includes(env.DEPLOYMENT_ENV?.trim() ?? '')
  ) {
    throw new Error('Set DEPLOYMENT_ENV explicitly in apps/backend/jobs/wrangler.jsonc.');
  }
};

export const requireJobsBindings = (raw: unknown): JobsEnv => {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('The jobs Worker received no bindings.');
  }
  const env = raw as JobsEnv;
  const profile = resolveJobsProfile(env);
  if (!profile.ok) {
    throw new Error(`${profile.problem} ${profile.remedy}`);
  }
  requireJobsDeploymentEnvironment(env);
  if (profile.profile === 'disabled') {
    return env;
  }
  const missing = [
    ['SUPABASE_URL', env.SUPABASE_URL],
    ['SUPABASE_ANON_KEY', env.SUPABASE_ANON_KEY],
    ['SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY],
    ['MEDIA', env.MEDIA],
    ['ENCODE_WORKFLOW', env.ENCODE_WORKFLOW],
    ['MAINTENANCE_WORKFLOW', env.MAINTENANCE_WORKFLOW],
    ['GOOGLE_CLOUD_PROJECT', env.GOOGLE_CLOUD_PROJECT],
    ['GOOGLE_CLOUD_REGION', env.GOOGLE_CLOUD_REGION],
    ['GOOGLE_CLOUD_RUN_JOB', env.GOOGLE_CLOUD_RUN_JOB],
    ['GOOGLE_RUNNER_SERVICE_ACCOUNT', env.GOOGLE_RUNNER_SERVICE_ACCOUNT],
    ['GOOGLE_RUNNER_SUBJECT', env.GOOGLE_RUNNER_SUBJECT],
    ['GOOGLE_RUNNER_AUDIENCE', env.GOOGLE_RUNNER_AUDIENCE],
    ['GOOGLE_DISPATCHER_CREDENTIAL', env.GOOGLE_DISPATCHER_CREDENTIAL],
  ]
    .filter(([, value]) => value === undefined || value === '')
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`Cloud Run compute configuration is incomplete: ${missing.join(', ')}.`);
  }
  if (env.COMPUTE_PROTOCOL !== 'sample-v1') {
    throw new Error('COMPUTE_PROTOCOL must be sample-v1 for this runner.');
  }
  return env;
};

export type { WorkflowInstanceBinding };

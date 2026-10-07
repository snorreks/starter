import { createAdminDatabaseClient } from '@starter/database/supabase';
import type { JobsEnv } from '../env.ts';
import { createCloudRunDispatch } from './dispatch.ts';
import { waitForExecution } from './execution.ts';
import { createGoogleOAuthProvider } from './oauth.ts';

/** Supabase/Postgres attempt path used only by the explicit preview profile. */
export const runCloudRunAttempt = async (
  env: JobsEnv,
  input: { jobId: string; attemptId: string },
  options: {
    signal?: AbortSignal;
    deadlineMs?: number;
    now?: () => number;
  } = {},
) => {
  const missing = [
    ['SUPABASE_URL', env.SUPABASE_URL],
    ['SUPABASE_ANON_KEY', env.SUPABASE_ANON_KEY],
    ['SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY],
    ['GOOGLE_CLOUD_PROJECT', env.GOOGLE_CLOUD_PROJECT],
    ['GOOGLE_CLOUD_REGION', env.GOOGLE_CLOUD_REGION],
    ['GOOGLE_CLOUD_RUN_JOB', env.GOOGLE_CLOUD_RUN_JOB],
    ['GOOGLE_DISPATCHER_CREDENTIAL', env.GOOGLE_DISPATCHER_CREDENTIAL],
    ['MEDIA', env.MEDIA],
  ]
    .filter(([, value]) => value === undefined || value === '')
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `Supabase Cloud Run compute configuration is incomplete: ${missing.join(', ')}.`,
    );
  }
  if (env.COMPUTE_PROTOCOL !== 'sample-v1') {
    throw new Error('COMPUTE_PROTOCOL must be sample-v1 for the current processor.');
  }
  const config = env as JobsEnv &
    Required<
      Pick<
        JobsEnv,
        | 'SUPABASE_URL'
        | 'SUPABASE_ANON_KEY'
        | 'SUPABASE_SERVICE_ROLE_KEY'
        | 'GOOGLE_CLOUD_PROJECT'
        | 'GOOGLE_CLOUD_REGION'
        | 'GOOGLE_CLOUD_RUN_JOB'
        | 'GOOGLE_DISPATCHER_CREDENTIAL'
        | 'MEDIA'
      >
    >;

  const admin = createAdminDatabaseClient({
    url: config.SUPABASE_URL,
    anonKey: config.SUPABASE_ANON_KEY,
    serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
  });
  const priorFailure = async () => {
    const { data, error } = await admin.rpc('cloud_run_attempt_failure', {
      p_job_id: input.jobId,
      p_attempt_id: input.attemptId,
    });
    if (error) {
      throw new Error('Postgres could not reconcile the fenced Cloud Run attempt.');
    }
    const result = data?.[0];
    if (!result) {
      return { outcome: 'fenced' as const };
    }
    return result.job_status === 'failed'
      ? { outcome: 'terminal_failure' as const, errorCode: result.error_code }
      : { outcome: 'retryable_failure' as const, errorCode: result.error_code };
  };
  try {
    const { data: claimed, error: claimError } = await admin.rpc('claim_encode_job', {
      p_job_id: input.jobId,
      p_attempt_id: input.attemptId,
      p_lease_seconds: 1200,
    });
    if (claimError) {
      throw new Error('Postgres refused to claim the job attempt.');
    }
    if (claimed !== true) {
      return await priorFailure();
    }
    const token = createGoogleOAuthProvider({ secret: config.GOOGLE_DISPATCHER_CREDENTIAL });
    const dispatch = createCloudRunDispatch({
      project: config.GOOGLE_CLOUD_PROJECT,
      region: config.GOOGLE_CLOUD_REGION,
      job: config.GOOGLE_CLOUD_RUN_JOB,
      token,
    });
    const started = await dispatch.dispatch(input.jobId, input.attemptId);
    const { error: recordError } = await admin.rpc('record_cloud_run_execution', {
      p_job_id: input.jobId,
      p_attempt_id: input.attemptId,
      p_execution_name: started.execution,
    });
    if (recordError) {
      throw new Error(
        'Cloud Run accepted the attempt but Postgres could not record its execution.',
      );
    }
    const state = await waitForExecution({
      dispatch,
      jobId: input.jobId,
      attemptId: input.attemptId,
      deadlineMs: options.deadlineMs ?? 15 * 60_000,
      signal: options.signal,
      now: options.now,
    });
    if (state !== 'SUCCEEDED') {
      if (state === 'CANCELLED') {
        await admin.rpc('fail_encode_job', {
          p_job_id: input.jobId,
          p_attempt_id: input.attemptId,
          p_error_code: 'cancelled',
          p_retryable: true,
        });
        return { outcome: 'retryable_failure' as const };
      }
      const failure = await priorFailure();
      if (failure.outcome !== 'fenced') {
        return failure;
      }
      await admin.rpc('fail_encode_job', {
        p_job_id: input.jobId,
        p_attempt_id: input.attemptId,
        p_error_code: 'internal_error',
        p_retryable: true,
      });
      return { outcome: 'retryable_failure' as const };
    }
    const outputKey = `media/v1/jobs/${input.jobId}/attempts/${input.attemptId}.mp4`;
    const object = await config.MEDIA.head(outputKey);
    const metadata = object?.customMetadata;
    const bytes = object?.size;
    const sha256 = metadata?.sha256;
    if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw new Error('Cloud Run output did not contain a valid SHA-256 digest.');
    }
    if (
      !object ||
      bytes === undefined ||
      bytes <= 0 ||
      bytes > 10 * 1024 * 1024 ||
      metadata?.jobId !== input.jobId ||
      metadata?.attemptId !== input.attemptId ||
      metadata?.key !== outputKey ||
      !/^[a-f0-9]{64}$/.test(sha256)
    ) {
      throw new Error(
        'Cloud Run output did not match the active attempt, object key, size or hash.',
      );
    }
    const { data: completed, error: completeError } = await admin.rpc('finish_encode_job', {
      p_job_id: input.jobId,
      p_attempt_id: input.attemptId,
      p_output_key: outputKey,
      p_output_bytes: bytes,
      p_sha256: sha256,
      p_format: 'mp4',
      p_codec: metadata?.codec ?? 'h264',
      p_width: Number(metadata?.width ?? 320),
      p_height: Number(metadata?.height ?? 180),
      p_duration_ms: Number(metadata?.durationMs ?? 3000),
    });
    if (completeError) {
      throw new Error('Postgres failed to commit the verified Cloud Run output.');
    }
    if (completed !== true) {
      await config.MEDIA.delete(outputKey);
      return { outcome: 'fenced' as const };
    }
    return { outcome: 'committed' as const, bytes, sha256 };
  } catch (_error) {
    // The database fence remains authoritative if this recovery write is stale.
    await admin.rpc('fail_encode_job', {
      p_job_id: input.jobId,
      p_attempt_id: input.attemptId,
      p_error_code: 'internal_error',
      p_retryable: true,
    });
    return { outcome: 'retryable_failure' as const };
  }
};

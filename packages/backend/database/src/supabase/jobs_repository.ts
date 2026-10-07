import type { SupabaseClient } from './client.ts';
import type { Database } from './database.types.ts';

export interface JobAdmission {
  outcome: 'created' | 'replayed' | 'idempotency_conflict' | 'quota_or_active_limit';
  jobId: string | null;
}
export interface JobRepository {
  admit(input: {
    id: string;
    fixture: string;
    preset: string;
    idempotencyKey: string;
    fingerprint: string;
    workflowId: string;
  }): Promise<JobAdmission>;
  listForOwner(): Promise<readonly SupabaseJobStatus[]>;
  getForOwner(jobId: string): Promise<SupabaseJobStatus | null>;
  disableDispatch(jobId: string): Promise<boolean>;
  markDispatched(jobId: string): Promise<boolean>;
  markDispatchFailed(jobId: string, code: string): Promise<boolean>;
  recordExecution(jobId: string, attemptId: string, executionName: string): Promise<boolean>;
  fail(jobId: string, attemptId: string, code: string, retryable: boolean): Promise<boolean>;
  authorizeRunner(
    jobId: string,
    attemptId: string,
    executionName: string,
  ): Promise<RunnerAttempt | null>;
  claim(jobId: string, attemptId: string, leaseSeconds?: number): Promise<boolean>;
  complete(input: {
    jobId: string;
    attemptId: string;
    outputKey: string;
    bytes: number;
    sha256: string;
    format: string;
    codec: string;
    width: number;
    height: number;
    durationMs: number;
  }): Promise<boolean>;
}
export interface RunnerAttempt {
  jobId: string;
  attemptId: string;
  fixture: string;
  preset: string;
  outputKey: string;
  expiresAt: number;
}
export interface SupabaseJobStatus {
  id: string;
  kind: 'encode';
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  dispatchState: 'pending' | 'dispatched' | 'dispatch_failed';
  createdAt: number;
  updatedAt: number;
  outputAvailable: boolean;
  errorCode: string | null;
}
const jobDto = (value: unknown): SupabaseJobStatus | null => {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    row.kind !== 'encode' ||
    !['pending', 'running', 'succeeded', 'failed'].includes(String(row.status)) ||
    !['pending', 'dispatched', 'dispatch_failed'].includes(String(row.dispatchState)) ||
    typeof row.createdAt !== 'number' ||
    typeof row.updatedAt !== 'number' ||
    typeof row.outputAvailable !== 'boolean' ||
    !(row.errorCode === null || typeof row.errorCode === 'string')
  ) {
    return null;
  }
  return row as unknown as SupabaseJobStatus;
};
export const createSupabaseJobRepository = (
  userClient: SupabaseClient<Database>,
  serviceClient: SupabaseClient<Database>,
): JobRepository => ({
  async admit(input) {
    const { data, error } = await userClient.rpc('admit_encode_job', {
      p_job_id: input.id,
      p_fixture: input.fixture,
      p_preset: input.preset,
      p_idempotency_key: input.idempotencyKey,
      p_fingerprint: input.fingerprint,
      p_workflow_id: input.workflowId,
    });
    if (error !== null) {
      throw new Error(`Supabase job admission: ${error.message}`);
    }
    const row = data?.[0];
    if (row === undefined) {
      throw new Error('Supabase job admission returned no result.');
    }
    const outcome: JobAdmission['outcome'] =
      row.outcome === 'created' ||
      row.outcome === 'replayed' ||
      row.outcome === 'idempotency_conflict'
        ? row.outcome
        : 'quota_or_active_limit';
    return { outcome, jobId: row.job_id };
  },
  async listForOwner() {
    const { data, error } = await userClient.rpc('list_encode_jobs');
    if (error !== null) {
      throw new Error(`Supabase job list: ${error.message}`);
    }
    if (!Array.isArray(data)) {
      throw new Error('Supabase job list returned an invalid result.');
    }
    const rows = data.map(jobDto);
    if (rows.some((row) => row === null)) {
      throw new Error('Supabase job list returned an invalid row.');
    }
    return rows as SupabaseJobStatus[];
  },
  async getForOwner(jobId) {
    const { data, error } = await userClient.rpc('get_encode_job', { p_job_id: jobId });
    if (error !== null) {
      throw new Error(`Supabase job read: ${error.message}`);
    }
    return jobDto(data);
  },
  async disableDispatch(jobId) {
    const { data, error } = await serviceClient.rpc('record_job_dispatch', {
      p_job_id: jobId,
      p_dispatch_state: 'dispatch_failed',
      p_error_code: 'dispatch_disabled_pending_prompt_06',
    });
    if (error !== null) {
      throw new Error(`Supabase job dispatch state: ${error.message}`);
    }
    return data === true;
  },
  async markDispatched(jobId) {
    const { data, error } = await serviceClient.rpc('record_job_dispatch', {
      p_job_id: jobId,
      p_dispatch_state: 'dispatched',
    });
    if (error !== null) {
      throw new Error(`Supabase job dispatch state: ${error.message}`);
    }
    return data === true;
  },
  async markDispatchFailed(jobId, code) {
    const { data, error } = await serviceClient.rpc('record_job_dispatch', {
      p_job_id: jobId,
      p_dispatch_state: 'dispatch_failed',
      p_error_code: code,
    });
    if (error !== null) {
      throw new Error(`Supabase job dispatch failure: ${error.message}`);
    }
    return data === true;
  },
  async recordExecution(jobId, attemptId, executionName) {
    const { data, error } = await serviceClient.rpc('record_cloud_run_execution', {
      p_job_id: jobId,
      p_attempt_id: attemptId,
      p_execution_name: executionName,
    });
    if (error !== null) {
      throw new Error(`Supabase Cloud Run execution record: ${error.message}`);
    }
    return data === true;
  },
  async fail(jobId, attemptId, code, retryable) {
    const { data, error } = await serviceClient.rpc('fail_encode_job', {
      p_job_id: jobId,
      p_attempt_id: attemptId,
      p_error_code: code,
      p_retryable: retryable,
    });
    if (error !== null) {
      throw new Error(`Supabase job failure: ${error.message}`);
    }
    return data === true;
  },
  async authorizeRunner(jobId, attemptId, executionName) {
    const { data, error } = await serviceClient.rpc('authorize_job_runner', {
      p_job_id: jobId,
      p_attempt_id: attemptId,
      p_execution_name: executionName,
    });
    if (error !== null) {
      throw new Error(`Supabase runner authorization: ${error.message}`);
    }
    const row = data?.[0];
    if (row === undefined) {
      return null;
    }
    if (
      row.job_id !== jobId ||
      row.attempt_id !== attemptId ||
      typeof row.fixture !== 'string' ||
      typeof row.preset !== 'string' ||
      typeof row.output_key !== 'string' ||
      typeof row.expires_at !== 'string'
    ) {
      throw new Error('Supabase runner authorization returned an invalid row.');
    }
    const expiresAt = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAt)) {
      throw new Error('Supabase runner authorization returned an invalid expiry.');
    }
    return {
      jobId,
      attemptId,
      fixture: row.fixture,
      preset: row.preset,
      outputKey: row.output_key,
      expiresAt,
    };
  },
  async claim(jobId, attemptId, leaseSeconds = 300) {
    const { data, error } = await serviceClient.rpc('claim_encode_job', {
      p_job_id: jobId,
      p_attempt_id: attemptId,
      p_lease_seconds: leaseSeconds,
    });
    if (error !== null) {
      throw new Error(`Supabase job claim: ${error.message}`);
    }
    return data === true;
  },
  async complete(input) {
    const { data, error } = await serviceClient.rpc('finish_encode_job', {
      p_job_id: input.jobId,
      p_attempt_id: input.attemptId,
      p_output_key: input.outputKey,
      p_output_bytes: input.bytes,
      p_sha256: input.sha256,
      p_format: input.format,
      p_codec: input.codec,
      p_width: input.width,
      p_height: input.height,
      p_duration_ms: input.durationMs,
    });
    if (error !== null) {
      throw new Error(`Supabase job completion: ${error.message}`);
    }
    return data === true;
  },
});

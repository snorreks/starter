import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import * as database from '@starter/database/supabase';
import type { JobsEnv } from '../env.ts';
import { runCloudRunAttempt } from './compute.ts';
import * as dispatch from './dispatch.ts';
import * as execution from './execution.ts';
import * as oauth from './oauth.ts';

afterEach(() => mock.restore());
const env = {
  SUPABASE_URL: 'https://db.example',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  GOOGLE_CLOUD_PROJECT: 'p',
  GOOGLE_CLOUD_REGION: 'r',
  GOOGLE_CLOUD_RUN_JOB: 'j',
  GOOGLE_DISPATCHER_CREDENTIAL: 'fixture',
  MEDIA: {},
  COMPUTE_PROTOCOL: 'sample-v1',
} as JobsEnv;
const input = { jobId: 'job_a', attemptId: 'attempt_a' };

for (const scenario of ['reconcile_error', 'fenced', 'terminal', 'retryable'] as const) {
  test(`Cloud Run failure recovery preserves ${scenario}`, async () => {
    const rpc = mock(async (name: string, _args: Record<string, unknown>) => {
      if (name === 'claim_encode_job') {
        return { data: scenario !== 'reconcile_error', error: null };
      }
      if (name === 'cloud_run_attempt_failure') {
        if (scenario === 'reconcile_error') {
          return { data: null, error: { message: 'unavailable' } };
        }
        return {
          data:
            scenario === 'fenced'
              ? []
              : [
                  {
                    job_status: scenario === 'terminal' ? 'failed' : 'pending',
                    error_code: 'invalid_media',
                  },
                ],
          error: null,
        };
      }
      return { data: true, error: null };
    });
    spyOn(database, 'createAdminDatabaseClient').mockReturnValue({ rpc } as never);
    spyOn(oauth, 'createGoogleOAuthProvider').mockReturnValue(async () => 'token');
    spyOn(dispatch, 'createCloudRunDispatch').mockReturnValue({
      dispatch: async () => ({ execution: 'execution', accepted: true }),
      find: async () => null,
    });
    spyOn(execution, 'waitForExecution').mockResolvedValue('FAILED');
    expect(await runCloudRunAttempt(env, input)).toEqual(
      scenario === 'terminal' || scenario === 'retryable'
        ? {
            outcome: scenario === 'terminal' ? 'terminal_failure' : 'retryable_failure',
            errorCode: 'invalid_media',
          }
        : { outcome: 'retryable_failure' },
    );
    const failures = rpc.mock.calls.filter(([name]) => name === 'fail_encode_job');
    if (scenario === 'reconcile_error' || scenario === 'fenced') {
      expect(failures).toEqual([
        [
          'fail_encode_job',
          {
            p_job_id: input.jobId,
            p_attempt_id: input.attemptId,
            p_error_code: 'internal_error',
            p_retryable: true,
          },
        ],
      ]);
    } else {
      expect(failures).toEqual([]);
    }
  });
}

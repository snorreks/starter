import { createAdminDatabaseClient } from '@starter/database/supabase';
import { verifyRunnerIdentity } from '@starter/jobs';
import { jwtVerify, SignJWT } from 'jose';

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const processorFailureForExitCode = (exitCode: number) => {
  const failures: Record<number, { code: string; retryable: boolean }> = {
    2: { code: 'invalid_request', retryable: false },
    3: { code: 'protocol_mismatch', retryable: false },
    4: { code: 'invalid_input', retryable: false },
    5: { code: 'invalid_media', retryable: false },
    6: { code: 'invalid_output', retryable: false },
    7: { code: 'deadline_exceeded', retryable: true },
    8: { code: 'cancelled', retryable: true },
    9: { code: 'internal_error', retryable: true },
  };
  return failures[exitCode];
};

export interface RunnerGrantEnv {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  RUNNER_GRANT_SECRET?: string;
  GOOGLE_RUNNER_AUDIENCE?: string;
  GOOGLE_RUNNER_SERVICE_ACCOUNT?: string;
  GOOGLE_RUNNER_SUBJECT?: string;
  MEDIA?: R2Bucket;
}

const requireEnv = (env: RunnerGrantEnv) => {
  const missing = [
    ['SUPABASE_URL', env.SUPABASE_URL],
    ['SUPABASE_ANON_KEY', env.SUPABASE_ANON_KEY],
    ['SUPABASE_SERVICE_ROLE_KEY', env.SUPABASE_SERVICE_ROLE_KEY],
    ['RUNNER_GRANT_SECRET', env.RUNNER_GRANT_SECRET],
    ['GOOGLE_RUNNER_AUDIENCE', env.GOOGLE_RUNNER_AUDIENCE],
    ['GOOGLE_RUNNER_SERVICE_ACCOUNT', env.GOOGLE_RUNNER_SERVICE_ACCOUNT],
    ['GOOGLE_RUNNER_SUBJECT', env.GOOGLE_RUNNER_SUBJECT],
    ['MEDIA', env.MEDIA],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`Runner grant configuration is incomplete: ${missing.join(', ')}.`);
  }
  const grantSecret = env.RUNNER_GRANT_SECRET ?? '';
  if (new TextEncoder().encode(grantSecret).byteLength < 32) {
    throw new Error('RUNNER_GRANT_SECRET must contain at least 32 bytes.');
  }
  return env as Required<RunnerGrantEnv>;
};

const tokenKey = (secret: string) => new TextEncoder().encode(secret);

export const createRunnerGrantService = (env: RunnerGrantEnv, origin: string) => {
  const config = requireEnv(env);
  const base = new URL(origin);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) {
    throw new Error('Runner grants require an HTTPS application origin.');
  }
  const admin = createAdminDatabaseClient({
    url: config.SUPABASE_URL,
    anonKey: config.SUPABASE_ANON_KEY,
    serviceRoleKey: config.SUPABASE_SERVICE_ROLE_KEY,
  });
  const pathFor = (jobId: string) =>
    `${base.origin}/api/internal/jobs/${encodeURIComponent(jobId)}/grants`;
  const activeAttempt = async (jobId: string, attemptId: string, executionName: string) => {
    const { data, error } = await admin.rpc('authorize_job_runner', {
      p_job_id: jobId,
      p_attempt_id: attemptId,
      p_execution_name: executionName,
    });
    if (error) {
      throw new Error('Active attempt verification failed.');
    }
    return data?.[0] ?? null;
  };
  return {
    async issue(request: Request, jobId: string, attemptId: string, executionName: string) {
      if (!ID.test(jobId) || !ID.test(attemptId)) {
        throw new Error('Invalid job or attempt identifier.');
      }
      if (
        !/^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/jobs\/[a-z0-9-]+\/executions\/[A-Za-z0-9-]+$/.test(
          executionName,
        )
      ) {
        throw new Error('Invalid Cloud Run execution identity.');
      }
      const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
      if (!bearer) {
        throw new Error('Runner identity is required.');
      }
      await verifyRunnerIdentity(bearer, {
        audience: config.GOOGLE_RUNNER_AUDIENCE,
        serviceAccount: config.GOOGLE_RUNNER_SERVICE_ACCOUNT,
        subject: config.GOOGLE_RUNNER_SUBJECT,
      });
      const attempt = await activeAttempt(jobId, attemptId, executionName);
      if (!attempt) {
        throw new Error('Runner attempt is not active.');
      }
      if (attempt.fixture !== 'sample-v1' || attempt.preset !== 'demo-180p-v1') {
        throw new Error('Runner attempt uses an unsupported protocol or preset.');
      }
      const expiry = Math.min(Date.parse(attempt.expires_at), Date.now() + 18 * 60_000);
      if (!Number.isFinite(expiry) || expiry <= Date.now()) {
        throw new Error('Runner attempt lease has expired.');
      }
      const grant = async (object: 'input' | 'output') =>
        new SignJWT({ jobId, attemptId, executionName, object, outputKey: attempt.output_key })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuer('starter-worker')
          .setAudience('starter-runner-grant')
          .setIssuedAt()
          .setExpirationTime(Math.floor(expiry / 1000))
          .sign(tokenKey(config.RUNNER_GRANT_SECRET));
      const [inputToken, outputToken] = await Promise.all([grant('input'), grant('output')]);
      const endpoint = pathFor(jobId);
      return {
        jobId,
        attemptId,
        expiresAt: expiry,
        preset: attempt.preset,
        input: { url: `${endpoint}?object=input&grant=${encodeURIComponent(inputToken)}` },
        output: {
          url: `${endpoint}?object=output&grant=${encodeURIComponent(outputToken)}`,
          key: attempt.output_key,
        },
      };
    },
    async reportProcessorFailure(
      request: Request,
      jobId: string,
      attemptId: string,
      executionName: string,
      exitCode: number,
    ) {
      if (
        !ID.test(jobId) ||
        !ID.test(attemptId) ||
        !Number.isInteger(exitCode) ||
        exitCode < 2 ||
        exitCode > 9
      ) {
        throw new Error('Invalid processor failure report.');
      }
      const executionPattern =
        /^projects\/[a-z0-9-]+\/locations\/[a-z0-9-]+\/jobs\/[a-z0-9-]+\/executions\/[A-Za-z0-9-]+$/;
      if (!executionPattern.test(executionName)) {
        throw new Error('Invalid Cloud Run execution identity.');
      }
      const bearer = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
      if (!bearer) {
        throw new Error('Runner identity is required.');
      }
      await verifyRunnerIdentity(bearer, {
        audience: config.GOOGLE_RUNNER_AUDIENCE,
        serviceAccount: config.GOOGLE_RUNNER_SERVICE_ACCOUNT,
        subject: config.GOOGLE_RUNNER_SUBJECT,
      });
      if (!(await activeAttempt(jobId, attemptId, executionName))) {
        throw new Error('Runner attempt is not active.');
      }
      const failure = processorFailureForExitCode(exitCode);
      if (!failure) {
        throw new Error('Invalid processor failure report.');
      }
      const { data, error } = await admin.rpc('fail_encode_job', {
        p_job_id: jobId,
        p_attempt_id: attemptId,
        p_error_code: failure.code,
        p_retryable: failure.retryable,
      });
      if (error) {
        throw new Error('Postgres refused the fenced processor failure report.');
      }
      return data === true;
    },
    async transfer(request: Request, jobId: string, method: 'GET' | 'PUT') {
      const url = new URL(request.url);
      const object = url.searchParams.get('object');
      const grant = url.searchParams.get('grant');
      if (!ID.test(jobId) || !grant || (object !== 'input' && object !== 'output')) {
        throw new Error('Invalid object grant.');
      }
      const { payload } = await jwtVerify(grant, tokenKey(config.RUNNER_GRANT_SECRET), {
        issuer: 'starter-worker',
        audience: 'starter-runner-grant',
      });
      if (
        payload.jobId !== jobId ||
        payload.object !== object ||
        payload.attemptId === undefined ||
        method !== (object === 'input' ? 'GET' : 'PUT')
      ) {
        throw new Error('Object grant scope mismatch.');
      }
      const attemptId = String(payload.attemptId);
      const executionName = typeof payload.executionName === 'string' ? payload.executionName : '';
      const active = await activeAttempt(jobId, attemptId, executionName);
      if (!active || active.output_key !== payload.outputKey) {
        throw new Error('Runner attempt is no longer active.');
      }
      if (object === 'input') {
        const file = await config.MEDIA.get(`media/v1/fixtures/${active.fixture}.mp4`);
        if (!file || file.size > MAX_INPUT_BYTES) {
          throw new Error('Bounded input fixture is unavailable.');
        }
        return new Response(file.body, {
          headers: {
            'content-type': 'video/mp4',
            'content-length': String(file.size),
            'cache-control': 'no-store',
          },
        });
      }
      const maxBytes = MAX_OUTPUT_BYTES;
      const chunks: Uint8Array[] = [];
      let length = 0;
      const reader = request.body?.getReader();
      if (!reader) {
        throw new Error('Runner output body is required.');
      }
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) {
            break;
          }
          length += part.value.byteLength;
          if (length > maxBytes) {
            await reader.cancel();
            throw new Error('Runner output exceeds its byte ceiling.');
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const expected = request.headers.get('x-output-sha256');
      const actual = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
        .map((part) => part.toString(16).padStart(2, '0'))
        .join('');
      if (bytes.byteLength === 0 || expected !== actual) {
        throw new Error('Runner output integrity check failed.');
      }
      const codec = request.headers.get('x-output-codec');
      const width = request.headers.get('x-output-width');
      const height = request.headers.get('x-output-height');
      const durationMs = request.headers.get('x-output-duration-ms');
      if (
        codec !== 'h264' ||
        !/^[1-9]\d{0,4}$/.test(width ?? '') ||
        !/^[1-9]\d{0,4}$/.test(height ?? '') ||
        !/^[1-9]\d{0,6}$/.test(durationMs ?? '')
      ) {
        throw new Error('Runner output metadata is invalid.');
      }
      await config.MEDIA.put(active.output_key, bytes, {
        httpMetadata: { contentType: 'video/mp4' },
        customMetadata: {
          jobId,
          attemptId,
          key: active.output_key,
          sha256: actual,
          codec: codec ?? '',
          width: width ?? '',
          height: height ?? '',
          durationMs: durationMs ?? '',
        },
      });
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    },
  };
};

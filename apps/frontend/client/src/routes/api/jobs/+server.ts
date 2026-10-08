import { workflowIdFor } from '@starter/jobs';
import { checkSchema } from '@starter/schemas/common';
import {
  CreateEncodeJobSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
} from '@starter/schemas/jobs';
import { createId } from '@starter/utils';
import { json, jsonError, readJsonBody, unauthorized } from '#lib/server/http.ts';
import { dispatchAdmittedJob, publicSupabaseJob } from '#lib/server/supabase_context.ts';
import type { RequestHandler } from './$types';

const MAX_BODY_BYTES = 4 * 1024;
const unavailable = (message: string) => jsonError(503, 'jobs_profile_disabled', message);

export const GET: RequestHandler = async ({ locals }) => {
  const services = locals.applicationServices;
  if (!locals.user || !services || services.identity.user.id !== locals.user.id) {
    return unauthorized();
  }
  const jobs = await services.jobs.listForOwner();
  return json(200, { jobs: jobs.map(publicSupabaseJob), nextCursor: null, serverTime: Date.now() });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  const user = locals.user;
  const services = locals.applicationServices;
  if (!user || !services || services.identity.user.id !== user.id) {
    return unauthorized();
  }
  if (locals.container.jobsProfile !== 'encode') {
    return unavailable('Compute is explicitly disabled for this deployment.');
  }
  if (services.jobs.computeRequested && services.jobs.dispatch !== 'cloud_run') {
    return unavailable('Cloud Run compute prerequisites are incomplete; no job was admitted.');
  }
  if (!user.emailVerified) {
    return jsonError(
      403,
      'email_not_verified',
      'Confirm your email address before starting a job.',
    );
  }
  const key = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (key === null || !checkSchema(IdempotencyKeySchema, key)) {
    return jsonError(
      400,
      'invalid_idempotency_key',
      `Send a valid ${IDEMPOTENCY_KEY_HEADER} header.`,
    );
  }
  const parsed = await readJsonBody(request, CreateEncodeJobSchema, {
    maxBytes: MAX_BODY_BYTES,
    invalidStatus: 400,
  });
  if (!parsed.ok) {
    return parsed.response;
  }
  const id = createId('job');
  const attemptId = createId('attempt');
  const bytes = new TextEncoder().encode(JSON.stringify(parsed.value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const outcome = await services.jobs.admit({
    id,
    fixture: parsed.value.fixture,
    preset: parsed.value.preset,
    idempotencyKey: key,
    fingerprint: [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
    workflowId: workflowIdFor(id),
  });
  if (outcome.outcome === 'idempotency_conflict') {
    return jsonError(
      409,
      'idempotency_conflict',
      'That idempotency key was used for a different request.',
    );
  }
  if (outcome.outcome === 'quota_or_active_limit') {
    return jsonError(429, 'budget_exceeded', 'The job admission limit has been reached.');
  }
  const started = await dispatchAdmittedJob(services.jobs, outcome, {
    attemptId,
    fixture: parsed.value.fixture,
    preset: parsed.value.preset,
  });
  if (!started) {
    return jsonError(
      503,
      'job_dispatch_failed',
      'The admitted job could not be dispatched. Retry with the same idempotency key.',
    );
  }
  const job = outcome.jobId === null ? null : await services.jobs.getForOwner(outcome.jobId);
  return job === null
    ? jsonError(503, 'job_unavailable', 'The admitted job status could not be read.')
    : json(202, publicSupabaseJob(job));
};

const methodNotAllowed = (): Response =>
  jsonError(405, 'method_not_allowed', 'Use GET or POST here.');
export const PUT = methodNotAllowed;
export const DELETE = methodNotAllowed;

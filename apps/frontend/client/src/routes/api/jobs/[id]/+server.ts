// apps/frontend/client/src/routes/api/jobs/[id]/+server.ts
//
// `/api/jobs/:id` — one job. Read only.
//
// A job's state changes by an attempt and by a dispatch, both of which are
// internal transitions; there is no client verb that mutates a job. So this route
// has exactly one verb, and the other two answer 405 rather than leaving a client's
// framework to invent a 404.
//
// A job the caller does not own answers 404, not 403. `getJobForOwner` filters on
// `owner_id` in the same statement as the id, so "not yours" and "not there" are
// the same result; answering 403 would turn this into an existence oracle for other
// users' jobs.

import { json, jsonError, unauthorized } from '#lib/server/http.ts';
import { publicSupabaseJob } from '#lib/server/supabase_context.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
  const user = locals.user;
  if (user === null) {
    return unauthorized();
  }

  if (locals.context?.backendProfile === 'supabase') {
    const repository = locals.applicationServices?.jobs;
    if (!repository || locals.applicationServices?.identity.user.id !== user.id) {
      return unauthorized();
    }
    const job = await repository.getForOwner(params.id);
    if (job === null) {
      return jsonError(404, 'not_found', 'That job does not exist.');
    }
    return json(200, publicSupabaseJob(job));
  }

  if (locals.container.jobsProfile !== 'encode') {
    return jsonError(
      503,
      'jobs_profile_disabled',
      'This deployment has the jobs profile disabled, so jobs cannot be read here.',
    );
  }

  const job = await locals.container.jobs.get(user.id, params.id);
  if (job === null) {
    return jsonError(404, 'not_found', 'That job does not exist.');
  }
  return json(200, job);
};

const readOnly = (): Response =>
  jsonError(405, 'method_not_allowed', 'Use GET here. Jobs change by their own attempts.');

export const POST = readOnly;
export const PATCH = readOnly;
export const PUT = readOnly;
export const DELETE = readOnly;

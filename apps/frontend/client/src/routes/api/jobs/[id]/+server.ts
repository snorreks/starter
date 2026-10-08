import { json, jsonError, unauthorized } from '#lib/server/http.ts';
import { publicSupabaseJob } from '#lib/server/supabase_context.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
  const services = locals.applicationServices;
  if (!locals.user || !services || services.identity.user.id !== locals.user.id) {
    return unauthorized();
  }
  if (locals.container.jobsProfile !== 'encode') {
    return jsonError(
      503,
      'jobs_profile_disabled',
      'Compute is explicitly disabled for this deployment.',
    );
  }
  const job = await services.jobs.getForOwner(params.id);
  return job === null
    ? jsonError(404, 'not_found', 'That job does not exist.')
    : json(200, publicSupabaseJob(job));
};

const readOnly = (): Response => jsonError(405, 'method_not_allowed', 'Use GET here.');
export const POST = readOnly;
export const PATCH = readOnly;
export const PUT = readOnly;
export const DELETE = readOnly;

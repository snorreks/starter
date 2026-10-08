// apps/frontend/client/src/routes/api/jobs/maintenance/+server.ts
//
// `/api/jobs/maintenance` — what the scheduler actually did, last time.
//
// Read only, and authenticated, because "the last maintenance run" is a statement
// about this environment rather than about one owner: every signed-in user sees
// the same run, and none of them can change it. That is why it is a separate
// endpoint rather than a field on `JobDto` — a per-job copy of an environment-wide
// fact would be a second answer to the same question, and the two would be free to
// disagree.
//
// The two fields it reports are deliberately not one:
//
//   * `latest`        — the newest run of any trigger.
//   * `latestScheduled` — the newest run whose trigger is `scheduled`.
//
// Collapsing them is how a manual trigger gets reported as a natural scheduled
// firing, which the design calls the dishonest case. A deployment that has only
// ever been swept by hand says exactly that: `latestScheduled` is null.
//
// Thin like every route in this API: resolve the caller, ask the service, map the
// outcome to a status. No SQL, no trigger arithmetic.

import { LatestMaintenanceSchema } from '@starter/schemas/jobs';
import * as v from 'valibot';
import { jsonError, unauthorized } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
  const services = locals.applicationServices;
  if (!locals.user || !services || services.identity.user.id !== locals.user.id) {
    return unauthorized();
  }
  const result = v.safeParse(LatestMaintenanceSchema, await services.jobs.latestMaintenance());
  if (!result.success) {
    return jsonError(503, 'maintenance_status_unavailable', 'Maintenance history is unavailable.');
  }
  return Response.json(result.output, { headers: { 'cache-control': 'private, no-store' } });
};

const getOnly = (): Response =>
  jsonError(
    405,
    'method_not_allowed',
    'Use GET here. Maintenance runs are recorded by the schedule.',
  );
export const POST = getOnly;
export const PUT = getOnly;
export const PATCH = getOnly;
export const DELETE = getOnly;

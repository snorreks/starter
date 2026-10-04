// apps/frontend/client/src/routes/jobs/+page.server.ts
//
// The jobs route's server load.
//
// Same three properties as `notes/+page.server.ts`, applied to a screen whose
// capability is optional:
//
//   1. **It calls the jobs service directly.** Not `fetch('/api/jobs')` from inside
//      the process that serves `/api/jobs`. That round trip would be a second,
//      differently authenticated path to the same data, and a cookie that works in
//      the browser would have to survive a loopback request.
//
//   2. **It returns DTOs, not rows.** `JobDto` is already the wire shape, and the
//      maintenance evidence is the same closed DTO the API serves. The session
//      token, the bucket binding and the container are never in scope: the layout
//      load already narrowed `locals.user` to three named fields.
//
//   3. **A disabled profile is answered, not fetched.** When `JOBS_PROFILE` is
//      absent — the template's default — the load says so and the page renders
//      "switched off here" from the HTML. It does *not* ask the API for a 503 the
//      load already knows the answer to, and it does not leave notes and auth
//      broken, which is the regression this branch exists to prevent.

import type { JobDto, LatestMaintenance } from '@starter/schemas/jobs';
import { error, redirect } from '@sveltejs/kit';
import { JOBS_PROFILE_ENCODE } from '#lib/server/jobs_service.ts';
import type { PageServerLoad } from './$types';

/**
 * One read of both things the screen shows.
 *
 * A small helper rather than a second `JobDto` type spelled out here: the shape is
 * already the wire shape, and the type of "what the service returns" is the
 * service's, not a restatement of it in a route file.
 */
const readJobs = async (
  locals: App.Locals,
): Promise<{ jobs: JobDto[]; maintenance: LatestMaintenance | null }> => {
  const listed = await locals.container.jobs.list(locals.user?.id ?? '');
  if (!listed.ok) {
    error(400, listed.detail);
  }
  const jobs = listed.page.jobs;

  const evidence = await locals.container.jobs.latestMaintenance();
  return { jobs, maintenance: evidence.ok ? evidence.latest : null };
};

export const load: PageServerLoad = async ({ locals }) => {
  const user = locals.user;
  if (user === null) {
    redirect(303, '/login');
  }

  // The capability check comes before the read. `JOBS_PROFILE` is the deployment
  // mode, not a request: a Worker without it cannot list jobs either, so asking
  // would be a round trip whose only possible answers are 503 and a guess.
  if (locals.container.jobsProfile !== JOBS_PROFILE_ENCODE) {
    return {
      profile: 'disabled' as const,
      jobs: [],
      maintenance: null,
      serverTime: Date.now(),
    };
  }

  const { jobs, maintenance } = await readJobs(locals);
  return { profile: 'encode' as const, jobs, maintenance, serverTime: Date.now() };
};

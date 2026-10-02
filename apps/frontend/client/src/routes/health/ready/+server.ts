// apps/frontend/client/src/routes/health/ready/+server.ts
//
// Readiness: the bindings a real request needs, actually exercised.
//
// The distinction from `/health` is the point of having two endpoints:
//
//   * `/health`     — is the isolate serving? Configuration only. Cheap.
//   * `/health/ready` — would a request succeed right now? Touches D1.
//
// A Worker with a deleted database answers `200 ok` to `/health` forever, because
// nothing in a configuration read can fail. This route is what notices, and it is
// what the deploy pipeline checks after publishing so a broken release is caught by
// the run that created it rather than by the next person to open the site.
//
// **Bounded, and bounded on purpose.** The probe is `SELECT 1`: D1 answers it
// without touching a table, so it measures the *binding*, not the data. A probe
// that read `notes` would report unhealthy when the content is wrong rather than
// when the configuration is, and would put a query on the hot path of whatever
// polls it. Nothing here loops, retries or sleeps — a readiness probe that takes
// its time is a probe that has started costing more than it reports.
//
// **503, not 500.** A dependency being unreachable is this service being unable
// to accept work, which is what 503 means and what a load balancer acts on. It is
// distinct from the `{ error, message }` shape the `/api/*` routes use on purpose:
// this endpoint is not an API client, it is a probe.
//
// The body names the binding that failed and the cause. It never contains the
// binding's value, the account id or the database id: this endpoint is public, so
// everything in it is published.

import { healthHeaders, readiness } from '#lib/server/release.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals }) => {
  const report = await readiness(locals.container);

  return Response.json(report, {
    status: report.ok ? 200 : 503,
    headers: { ...healthHeaders, 'content-type': 'application/json; charset=utf-8' },
  });
};

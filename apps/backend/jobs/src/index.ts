// apps/backend/jobs/src/index.ts
//
// The jobs Worker: two Workflows, one container Durable Object, and no public API.
//
// What is exported, and why each export exists
// --------------------------------------------
//   `EncodeWorkflow`      named by `wrangler.jsonc`'s ENCODE_WORKFLOW binding
//   `MaintenanceWorkflow` named by MAINTENANCE_WORKFLOW, and the schedule that
//                         triggers it
//   `EncodeContainer`     named by CONTAINER, and by the container's own entry
//
// What is *not* exported is the second thing this repository used to have: a REST
// API for jobs. The public job API belongs to the web Worker, which owns the
// session, the authorization check and the one origin a browser talks to. This
// Worker is reachable only through its bindings, and the default handler below
// refuses everything that manages to reach it anyway.
//
// That refusal is not defensive decoration. A Worker with a `fetch` export and no
// route still answers anything a future `routes` entry — or a mistake — points at
// it, and "this Worker has no API" should be true by construction rather than by the
// absence of a configuration nobody has written yet.
//
// `waitUntil` is deliberately unused
// ----------------------------------
// The obvious way to write "return 202 now, finish the work afterwards" is to start
// the work and hand the promise to `waitUntil`. That is correct only inside the
// response window: when the response is sent, the platform may end the request, and
// work that dies with it is work that was never done. Every long operation here is a
// Workflow step, which the platform owns end to end — the caller may disconnect the
// instant it gets its 202 and the encode still finishes.

import { EncodeContainer } from './encode_container.ts';
import type { JobsEnv } from './env.ts';
import { EncodeWorkflow } from './workflows/encode_workflow.ts';
import { MaintenanceWorkflow } from './workflows/maintenance_workflow.ts';

export { EncodeContainer, EncodeWorkflow, MaintenanceWorkflow };

const NO_ROUTE_BODY =
  "This Worker has no HTTP API. Jobs are started through the web Worker's /api/jobs, " +
  'and maintenance runs on the schedule declared in wrangler.jsonc.';

export default {
  fetch(): Response {
    return new Response(NO_ROUTE_BODY, {
      status: 404,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        // A refusal that a cache could keep answering on the Worker's behalf.
        'cache-control': 'no-store',
      },
    });
  },
} satisfies ExportedHandler<JobsEnv>;

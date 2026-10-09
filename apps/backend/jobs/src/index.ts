// apps/backend/jobs/src/index.ts
//
// The jobs Worker: two Workflows, Cloud Run dispatch, and no public API.
//
// What is exported, and why each export exists
// --------------------------------------------
//   `EncodeWorkflow`      named by `wrangler.jsonc`'s ENCODE_WORKFLOW binding
//   `MaintenanceWorkflow` named by MAINTENANCE_WORKFLOW, and the schedule that
//                         triggers it
//   `scheduled`           starts the maintenance Workflow on its configured cron
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

import '#logger';
import {
  type JobsEnv,
  requireJobsBindings,
  requireJobsDeploymentEnvironment,
  resolveJobsProfile,
} from './env.ts';
import { EncodeWorkflow } from './workflows/encode_workflow.ts';
import { MaintenanceWorkflow } from './workflows/maintenance_workflow.ts';

export { EncodeWorkflow, MaintenanceWorkflow };

const NO_ROUTE_BODY =
  "This Worker has no HTTP API. Jobs are started through the web Worker's /api/jobs.";

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
  async scheduled(controller: ScheduledController, rawEnv: JobsEnv): Promise<void> {
    const profile = resolveJobsProfile(rawEnv);
    if (!profile.ok) {
      throw new Error(`${profile.problem} ${profile.remedy}`);
    }
    requireJobsDeploymentEnvironment(rawEnv);
    if (profile.profile === 'disabled') {
      return;
    }
    const env = requireJobsBindings(rawEnv);
    const scheduledAt = new Date(controller.scheduledTime);
    const slot = scheduledAt.toISOString();
    const id = `maintenance-${controller.scheduledTime}`;
    try {
      await env.MAINTENANCE_WORKFLOW?.create({
        id,
        params: { runKey: `scheduled:${slot}`, trigger: 'scheduled', slot, scheduledTime: slot },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('already_exists')) {
        throw error;
      }
      const existing = await env.MAINTENANCE_WORKFLOW?.get(id);
      const state = await existing?.status();
      if (
        !state ||
        !['queued', 'running', 'waiting', 'paused', 'waitingForPause', 'complete'].includes(
          state.status,
        )
      ) {
        throw new Error(`Scheduled maintenance instance ${id} exists in an unexpected state.`);
      }
    }
  },
} satisfies ExportedHandler<JobsEnv>;

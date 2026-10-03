// apps/backend/jobs/src/workflows/maintenance_workflow.ts
//
// The hourly sweep, and the recovery pass that follows it.
//
// Two things run here, in this order, and the order is the design:
//
//   1. **Maintenance.** Bounded deletion of expired sessions, idle rate-limit
//      windows and expired artifacts, plus the terminalisation of jobs that are
//      stuck. It is reusable code in `@starter/jobs`; this file owns *when* it
//      runs and *what is recorded*, not how it deletes anything.
//
//   2. **Recovery.** Every admitted job whose Workflow was never started — the
//      crash between the D1 admission and the Workflow call — is dispatched now, in
//      a bounded batch, by addressing its own deterministic instance id. A retried
//      dispatch costs one `create` against an instance that already exists; that is
//      the price of recovery, and it is bounded by the admission budget that already
//      stopped the first attempt.
//
// Not an autonomous encoder
// ------------------------
// There is no job in here. A scheduler that encodes a video on every firing would
// be a demonstration of a cron expression and a demonstration of nothing else — and
// it would spend money on a Workers Paid plan every hour. The scheduler's proof is
// the run record: one row per slot, truthful counts, a label that says whether the
// run was scheduled or started by a human.
//
// Deduplication is the database's job
// -----------------------------------
// `maintenance_runs.run_key` is a primary key derived from the trigger, so a second
// firing of one slot affects no rows. That is not a check this Workflow performs and
// it is not a promise the schedule makes — a retried firing, a duplicated
// configuration and a manual trigger that lands on the same minute are all answered
// by the same `INSERT … ON CONFLICT DO NOTHING`.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import {
  createJobRepository,
  createMaintenanceRunRepository,
  createWorkflowDispatchPort,
  dispatchTargetFor,
  MAX_MAINTENANCE_BATCH,
  type MaintenanceReport,
  type MaintenanceRunRequest,
  runMaintenance,
  systemClock,
  type WorkflowInstanceBinding,
} from '@starter/jobs';
import type { JobsEnv } from '../env.ts';
import { createMediaStore, type MediaStore } from '../media_store.ts';

export type { MaintenanceRunRequest };

/** How many stuck jobs one run may dispatch. Bounded, like every batch here. */
export const MAX_RECOVERY_DISPATCHES = MAX_MAINTENANCE_BATCH;

/**
 * The manual payload.
 *
 * `unknown` for the *runtime* event, because a cron firing sends no payload at all
 * and the two shapes have to share one signature. This named type is what the run
 * method accepts, and `requestFor` narrows an untrusted payload into a
 * `MaintenanceRunRequest` before anything reads a field.
 */
export interface MaintenanceWorkflowParams {
  /** Present only for a manual invocation. A retried request reuses it. */
  requestId?: string;
}

interface ClaimedRun {
  claimed: true;
  runKey: string;
  tookOver: boolean;
}

interface SkippedRun {
  claimed: false;
  reason: 'already_finished' | 'in_progress';
  runKey: string;
}

type ClaimResult = ClaimedRun | SkippedRun;

interface SweepSuccess {
  ok: true;
  report: MaintenanceReport;
}

interface SweepFailure {
  ok: false;
  code: 'sweep_failed';
}

type SweepResult = SweepSuccess | SweepFailure;

interface RecoveryResult {
  dispatched: number;
  refused: number;
  remaining: number;
}

export class MaintenanceWorkflow extends WorkflowEntrypoint<JobsEnv, MaintenanceWorkflowParams> {
  override async run(event: WorkflowEvent<MaintenanceWorkflowParams>, step: WorkflowStep) {
    // The provider's `schedule` is the authority for *what fired this*. The payload
    // is used only for a manual invocation's request id, because a cron firing has
    // no payload at all. Deriving the trigger from one shape or the other — rather
    // than from an operator's memory — is what makes "this run was scheduled"
    // checkable.
    const request = this.requestFor(event);
    const runs = createMaintenanceRunRepository(this.env.DB, systemClock);
    const repository = createJobRepository(this.env.DB, systemClock);
    const store: MediaStore = createMediaStore(this.env.MEDIA);

    const claim = await step.do<ClaimResult>('claim', async () => {
      const outcome = await runs.begin(request, systemClock.now());
      return outcome.ok
        ? { claimed: true, runKey: outcome.run.runKey, tookOver: outcome.tookOver }
        : { claimed: false, reason: outcome.reason, runKey: outcome.run.runKey };
    });

    if (!claim.claimed) {
      // A duplicate firing or an overlapping run. Both are recorded as *not run*
      // rather than as a success: this instance did no destructive work, and a
      // report that said "0 deleted, 0 errors" would read like a healthy sweep.
      return { runKey: claim.runKey, outcome: 'skipped', reason: claim.reason };
    }

    let report: MaintenanceReport;
    try {
      const swept = await step.do<SweepResult>('sweep', async () => {
        try {
          const result = await runMaintenance(this.env.DB, repository, store, systemClock, {
            runKey: claim.runKey,
            batch: MAX_MAINTENANCE_BATCH,
          });
          return { ok: true, report: result };
        } catch {
          // The message is not carried: it would be an exception's text, and it is
          // about to become a durable record that a future reader would trust.
          return { ok: false, code: 'sweep_failed' };
        }
      });
      if (!swept.ok) {
        throw new NonRetryableMaintenanceError(swept.code);
      }
      report = swept.report;
    } catch (error) {
      await step.do('record-failed-sweep', async () => {
        await runs.fail(claim.runKey, 'sweep_failed');
        return true;
      });
      return {
        runKey: claim.runKey,
        outcome: 'failed',
        code: error instanceof NonRetryableMaintenanceError ? error.code : 'sweep_failed',
      };
    }

    // The bytes go, and the rows close.
    //
    // `purgeExpiredArtifacts` in `@starter/jobs` deliberately does not delete bytes:
    // it queues the keys and closes a retirement only when the storage owner says
    // the object is gone. This Worker *is* the storage owner, so deleting them is
    // this file's job, and it runs after the sweep so the run can close what it
    // queued in the same pass. A run that only queued would leave the next hour's
    // run to finish work this one started — recoverable, and one extra hour of
    // latency for every artifact.
    const retired = await step.do<{ deleted: number }>('delete-expired-bytes', async () => {
      const queued = await repository.listArtifactRetirements(MAX_MAINTENANCE_BATCH);
      let deleted = 0;
      for (const retirement of queued) {
        await store.delete(retirement.outputKey);
        // R2's delete is idempotent, so an object that was already absent and one
        // that was just removed are the same outcome. The row is closed only after
        // the store confirms the object is gone, and both writes are reported.
        if (await store.isRemoved(retirement.outputKey)) {
          await repository.completeArtifactRetirement(retirement.jobId);
          if (await repository.clearJobOutput(retirement.jobId)) {
            deleted += 1;
          }
        } else {
          await repository.recordArtifactRetirementRetry(retirement.jobId);
        }
      }
      return { deleted };
    });

    const recovery = await step.do<RecoveryResult>('recover-dispatches', async () => {
      const port = createWorkflowDispatchPort(this.env.ENCODE_WORKFLOW as WorkflowInstanceBinding);
      const pending = await repository.listPendingDispatches(MAX_RECOVERY_DISPATCHES);
      let dispatched = 0;
      let refused = 0;
      for (const job of pending) {
        // One attempt id per recovery, derived from the job. Deterministic on
        // purpose: a second recovery pass for the same job addresses the same
        // instance and the same attempt, so it cannot double the work either.
        const outcome = await port.dispatch(dispatchTargetFor(job, `recovery-${job.id}`));
        if (outcome.ok) {
          await repository.markDispatched(job.id);
          dispatched += 1;
        } else {
          await repository.markDispatchFailed(job.id, outcome.code);
          refused += 1;
        }
      }
      const remaining = (await repository.listPendingDispatches(MAX_RECOVERY_DISPATCHES)).length;
      return { dispatched, refused, remaining };
    });

    await step.do('record', async () => {
      await runs.complete(claim.runKey, {
        ...report,
        // The run's own deletions count, merged with the sweep's. Two numbers for one
        // thing would be a report nobody can sum; this is the number of artifacts
        // whose bytes this run actually removed.
        artifactsRetired: report.artifactsRetired + retired.deleted,
        // The count recorded is the one a reader can act on: how many jobs are
        // *still* owed a dispatch after this run. Recording the number found before
        // recovery would report a backlog the run had just cleared.
        pendingDispatches: recovery.remaining,
      });
      return true;
    });

    return {
      runKey: claim.runKey,
      outcome: 'succeeded',
      trigger: request.trigger,
      report,
      recovery,
      retiredBytes: retired.deleted,
    };
  }

  /**
   * What started this instance.
   *
   * `event.schedule` present means the provider's cron fired. Absent means a human
   * (or a test, or a deployment pipeline) created the instance, and the payload's
   * `requestId` is what makes a retried manual request idempotent — falling back to
   * the instance id, which is itself deterministic per `create` call.
   */
  private requestFor(event: WorkflowEvent<MaintenanceWorkflowParams>): MaintenanceRunRequest {
    const payload = event.payload;
    const requestId =
      typeof payload.requestId === 'string' && payload.requestId.length > 0
        ? payload.requestId
        : `instance-${event.instanceId}`;
    if (event.schedule !== undefined) {
      return {
        trigger: 'scheduled',
        scheduledTimeMs: event.schedule.scheduledTime,
        cron: event.schedule.cron,
      };
    }
    return { trigger: 'manual', requestId };
  }
}

/**
 * A maintenance failure that must not be retried.
 *
 * The Workflow platform retries a failed step by default, and retrying a destructive
 * sweep that already ran is exactly what the run key is for — but retrying the
 * * *record* of a sweep that already failed would be noise. This error carries the
 * frozen code from `MAINTENANCE_FAILURE_CODES` and nothing else.
 */
class NonRetryableMaintenanceError extends Error {
  readonly code: 'sweep_failed' | 'dispatch_recovery_failed';

  constructor(code: 'sweep_failed' | 'dispatch_recovery_failed') {
    super(`maintenance ${code}`);
    this.code = code;
  }
}

// packages/backend/jobs/src/lib/dispatch_port.ts
//
// The typed seam between "D1 admitted this job" and "a Workflow instance exists
// for it".
//
// This is a port, not a queue. There is deliberately no retry loop, no worker, no
// backoff schedule and no dead-letter table here, because PR H owns all of that
// and a second implementation in this repository would be one more place for the
// two to disagree about when a job is recoverable.
//
// What the port states is the part that is *this* PR's contract:
//
//   * the instance id is derived from the job id, so a retry, a crash and a
//     reconciliation pass all address the same instance;
//   * dispatch is reported as a durable fact (`dispatched` / `dispatch_failed`)
//     against the job row, because the interesting failure is exactly the one
//     that loses memory — D1 committed the admission and then the Workflow call
//     failed, and a caller that answered 202 has to be able to find that job
//     later;
//   * a refusal carries a frozen code, never a provider message.
//
// `createDisabledDispatchPort` is the truthful implementation until PR H lands:
// it refuses every dispatch with `compute_profile_disabled`, which the API
// surfaces as a capability error rather than as a job that silently never runs.

import type { JobFixture, JobPreset } from '@starter/schemas/jobs';
import type { JobRecord } from './job_repository.ts';

/** What a dispatch needs to know, and nothing about the caller's identity. */
export interface DispatchTarget {
  jobId: string;
  /** The deterministic Workflow instance id for `jobId`. */
  workflowId: string;
  fixture: JobFixture;
  preset: JobPreset;
  /**
   * The attempt this dispatch starts. Echoed to the processor, which refuses
   * concurrent encodes and answers with the same id.
   */
  attemptId: string;
}

export type DispatchOutcome =
  | { ok: true }
  | {
      ok: false;
      /**
       * A frozen code from `DISPATCH_ERROR_CODES`. Bounded because it is stored on
       * the job row: a provider's error text stored there is provider text this
       * repository can neither bound nor redact later.
       */
      code: DispatchErrorCode;
      /** Fixed sentence for an operator. Never contains provider output. */
      message: string;
      /**
       * Whether re-dispatching the same job could plausibly succeed.
       *
       * A dispatcher that cannot say leaves this `false`: an unrecoverable
       * dispatch that is retried forever is the worse default, because it turns a
       * configuration mistake into a spend.
       */
      retryable: boolean;
    };

/** Each code's meaning is in `DISPATCH_ERROR_MEANINGS`; the list is the wire. */
export const DISPATCH_ERROR_CODES = [
  'compute_profile_disabled',
  'workflow_binding_missing',
  'provider_unavailable',
  'protocol_rejected',
] as const;

/** Maximum failed dispatch calls before recovery stops retrying. */
export const MAX_DISPATCH_ATTEMPTS = 3;

export type DispatchErrorCode = (typeof DISPATCH_ERROR_CODES)[number];

/**
 * What each code means and whether a retry could plausibly work.
 *
 * Kept beside the list rather than in the ports that raise it, so the decision is
 * written down once: an unrecoverable dispatch retried forever turns a
 * configuration mistake into a spend, which is the worse default.
 */
export const DISPATCH_ERROR_MEANINGS: Record<DispatchErrorCode, { retryable: boolean }> = {
  // The profile is off. The job is admitted and recoverable, so retrying after it
  // is enabled is exactly the right remedy.
  compute_profile_disabled: { retryable: true },
  // No binding. Same shape: a configuration gap, not a bad request.
  workflow_binding_missing: { retryable: true },
  // Transient provider refusal.
  provider_unavailable: { retryable: true },
  // The provider answered a shape this build cannot speak. Retrying changes
  // nothing; this build has to change.
  protocol_rejected: { retryable: false },
};

export interface WorkflowDispatchPort {
  /**
   * Start, or confirm, the Workflow instance for one job.
   *
   * Must be safe to call twice for the same job: the second call addresses the
   * same deterministic instance rather than starting a second one.
   */
  dispatch(target: DispatchTarget): Promise<DispatchOutcome>;
}

/**
 * The dispatcher used when no compute profile is configured.
 *
 * It refuses rather than succeeds, and the refusal names the missing capability.
 * A port that returned `{ ok: true }` here would let `POST /api/jobs` answer 202
 * for a job nothing will ever run — the precise failure the round-2 review called
 * out, and one that only shows up when somebody goes looking for the video.
 */
export const createDisabledDispatchPort = (): WorkflowDispatchPort => ({
  async dispatch() {
    return {
      ok: false,
      code: 'compute_profile_disabled',
      message:
        'This deployment has no jobs Worker bound, so no encode can be started. ' +
        'The job was admitted and is recoverable: enable the compute profile and ' +
        'recover its pending dispatch.',
      retryable: DISPATCH_ERROR_MEANINGS.compute_profile_disabled.retryable,
    };
  },
});

/** The dispatch target for a job, assembled from its own stored fields. */
export const dispatchTargetFor = (job: JobRecord, attemptId: string): DispatchTarget => ({
  jobId: job.id,
  workflowId: job.workflowId,
  fixture: job.fixture,
  preset: job.preset,
  attemptId,
});

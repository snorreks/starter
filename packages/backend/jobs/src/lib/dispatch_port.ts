// packages/backend/jobs/src/lib/dispatch_port.ts
//
// The typed seam between "Postgres admitted this job" and "a Workflow instance exists
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
//     that loses memory — Postgres committed the admission and then the Workflow call
//     failed, and a caller that answered 202 has to be able to find that job
//     later;
//   * a refusal carries a frozen code, never a provider message.
//
// `createDisabledDispatchPort` is the truthful implementation until PR H lands:
// it refuses every dispatch with `compute_profile_disabled`, which the API
// surfaces as a capability error rather than as a job that silently never runs.

import type { JobFixture, JobPreset } from '@starter/schemas/jobs';
import { workflowIdFor } from './job_identity.ts';

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
export const dispatchTargetFor = (
  job: { id: string; workflowId: string; fixture: JobFixture; preset: JobPreset },
  attemptId: string,
): DispatchTarget => ({
  jobId: job.id,
  workflowId: job.workflowId,
  fixture: job.fixture,
  preset: job.preset,
  attemptId,
});

// -----------------------------------------------------------------------------
// The provider binding
// -----------------------------------------------------------------------------

/**
 * The creation and status lookup this repository asks of a Workflow binding.
 *
 * Declared structurally so this package also runs outside workerd. A deterministic
 * id addresses the same instance on retry; when creation reports an existing
 * instance, its status must confirm that it has not errored or been terminated.
 */
export interface WorkflowInstanceBinding {
  create(options: { id: string; params?: unknown }): Promise<{ id: string }>;
  get(id: string): Promise<{ status(): Promise<{ status: string }> }>;
}

/**
 * Does this failure mean "the instance is already there"?
 *
 * The runtime this repository pins (wrangler 4.142.0's local runtime) throws a value
 * whose only structured field is its name; the code appears as the first
 * parenthesised token of the message, `WorkflowError: (instance.already_exists) …`.
 * So the code is *read* — from the property when one is present, and otherwise from
 * that anchored prefix — and the match itself is an exact comparison against
 * `already_exists`, not a substring search over prose.
 *
 * The direction of failure matters here. If a future runtime rewords the prefix, the
 * code does not match and the dispatch is recorded as a retryable provider failure —
 * a job that is recovered again rather than one that is silently marked dispatched.
 * That is the safe way to be wrong about a provider's vocabulary.
 */
const ALREADY_EXISTS_CODE = 'already_exists';

const errorCode = (error: unknown): string | null => {
  const declared = (error as { code?: unknown } | null | undefined)?.code;
  if (typeof declared === 'string' && declared.length > 0) {
    return declared;
  }
  const message = (error as { message?: unknown } | null | undefined)?.message;
  if (typeof message !== 'string') {
    return null;
  }
  return /^[A-Za-z]+Error:\s*\(([a-z_.]+)\)/.exec(message)?.[1] ?? null;
};

const isAlreadyExists = (error: unknown): boolean => {
  const code = errorCode(error);
  return code !== null && code.split('.').at(-1) === ALREADY_EXISTS_CODE;
};

/**
 * A dispatch port backed by a real Workflow binding.
 *
 * `binding` may be absent, and absent is a *refusal* rather than a default:
 * a Weber's binding set is its configuration, and a deployment whose jobs
 * profile is enabled without the binding would otherwise admit jobs that address
 * nothing.
 *
 * Failure classification is the interesting part:
 *
 *   * a thrown value from `create` is `provider_unavailable` and retryable,
 *     because a transport failure is exactly the case maintenance recovery exists
 *     for;
 *   * an answer that is not an object with a string `id` is `protocol_rejected`
 *     and *not* retryable. Something answered, and it answered in a shape this
 *     build cannot speak; retrying the same call cannot make the peer change its
 *     mind, and doing so turns a version mismatch into a spend.
 *
 * No provider text is stored or returned either way: the caller gets a frozen
 * code and a fixed sentence.
 */
export const createWorkflowDispatchPort = (
  binding: WorkflowInstanceBinding | null | undefined,
): WorkflowDispatchPort => ({
  async dispatch(target) {
    if (target.workflowId !== workflowIdFor(target.jobId)) {
      // A caller built the target by hand and named an instance id that is not
      // derived from the job. Honouring it would let one job be addressed by two
      // instances — two encodes, two budget spends, two leases — which is the
      // whole reason the id is derived in the first place.
      return {
        ok: false,
        code: 'protocol_rejected',
        message: 'The dispatch target named an instance id that is not derived from its job id.',
        retryable: DISPATCH_ERROR_MEANINGS.protocol_rejected.retryable,
      };
    }

    if (binding === null || binding === undefined) {
      return {
        ok: false,
        code: 'workflow_binding_missing',
        message:
          'No encode Workflow binding is present on this Worker, so the job cannot be started. ' +
          'The admission is recoverable: bind the jobs Worker and recover the pending dispatch.',
        retryable: DISPATCH_ERROR_MEANINGS.workflow_binding_missing.retryable,
      };
    }

    let created: unknown;
    try {
      created = await binding.create({
        id: target.workflowId,
        params: {
          jobId: target.jobId,
          fixture: target.fixture,
          preset: target.preset,
          attemptId: target.attemptId,
        },
      });
    } catch (error) {
      // An existing instance counts only if it can still run or has completed.
      // Failed instances and unavailable status reads remain recoverable failures.
      if (isAlreadyExists(error)) {
        try {
          const instance = await binding.get(target.workflowId);
          const { status } = await instance.status();
          if (
            typeof status === 'string' &&
            status.length > 0 &&
            status !== 'errored' &&
            status !== 'terminated'
          ) {
            return { ok: true };
          }
        } catch {
          // A failed lookup cannot certify that this job was dispatched.
        }
      }
      // The reason is deliberately not interpolated: it is provider text, and it
      // would end up stored on the job row.
      return {
        ok: false,
        code: 'provider_unavailable',
        message:
          'The Workflow provider refused to start the instance. The job is still recoverable.',
        retryable: DISPATCH_ERROR_MEANINGS.provider_unavailable.retryable,
      };
    }

    const id = (created as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id.length === 0) {
      return {
        ok: false,
        code: 'protocol_rejected',
        message: 'The Workflow provider answered with a shape this build cannot speak.',
        retryable: DISPATCH_ERROR_MEANINGS.protocol_rejected.retryable,
      };
    }

    return { ok: true };
  },
});

// packages/backend/jobs/src/lib/job_identity.ts
//
// The one function that turns a job id into a Workflow instance id.
//
// It lives in its own module because both sides of the identity need it and they
// must not import each other:
//
//   * `job_repository.ts` stores `workflow_id` on the row it writes;
//   * `dispatch_port.ts` refuses a dispatch whose instance id is not derived from
//     its job id.
//
// When the derivation lived in the repository, the dispatch port needed it too, and
// the port is imported *by* the repository — a value-level import cycle between two
// modules in the same package. It happens to work today because the cycle resolves
// to a live binding before either is called, which is exactly the kind of thing
// that breaks on the next edit and produces an error in an unrelated file. The
// shared definition is the fix, and it is cheaper than the bug.
//
// The derivation is the whole idempotency story for dispatch: a retry, a crash and a
// reconciliation pass all address `encode-<jobId>`, so there is one instance per job
// rather than one per attempt to start it.

import { WORKFLOW_ID_PREFIX } from '@starter/schemas/jobs';

/**
 * The Workflow instance id for a job.
 *
 * Derived, never stored from a request and never chosen by a caller: an id a
 * client could influence would let one job be addressed by two instances, which is
 * two encodes, two leases and two units of budget for one admission.
 */
export const workflowIdFor = (jobId: string): string => `${WORKFLOW_ID_PREFIX}${jobId}`;

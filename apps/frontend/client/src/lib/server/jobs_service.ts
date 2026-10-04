// apps/frontend/client/src/lib/server/jobs_service.ts
//
// The server service for jobs: capability resolution, admission, dispatch, and the
// owner-scoped output read.
//
// Same rule as `#lib/server/notes_service.ts`, and the reason is worth repeating
// because it is the whole authorization boundary: **the owner id is a required
// argument and the service has no way to obtain one.** The route adapter resolves
// who the caller is from the session the hook already built; this file cannot be
// reached without an answer already, so there is no code path in which a job is
// read or written for a caller nobody verified.
//
// Three things this service adds over the repository it delegates to:
//
//   1. **Capability.** A deployment with no compute profile answers every jobs
//      request with a named unavailability and leaves notes and auth untouched.
//      That is a truthful answer, not an error: the alternative is a 500 that
//      reads like a bug and a UI that cannot tell "not configured" from "broken".
//
//   2. **Dispatch.** Admission and dispatch are separate steps, on purpose. D1
//      commits the job; the Workflow call happens after. If it fails the job stays
//      `pending` / `dispatch_failed` and is recoverable, which is the exact crash
//      the design calls out. Swallowing the failure here instead would leave a
//      caller holding a 202 for a job nothing will ever run.
//
//   3. **The output seam.** Reading a result needs the private bucket, which this
//      PR does not bind. The seam exists and is typed now so PR H fills in the
//      reader rather than inventing a second ownership check next to this one.

import {
  type Clock,
  createDisabledDispatchPort,
  createJobRepository,
  createMaintenanceRunRepository,
  type DispatchOutcome,
  type JobRecord,
  type JobRepository,
  type JobsDatabase,
  MAINTENANCE_CRON,
  type MaintenanceRun,
  parseJobCursor,
  systemClock,
  type WorkflowDispatchPort,
} from '@starter/jobs';
import type {
  CreateEncodeJob,
  JobAdmissionErrorCodeValue,
  JobDto,
  JobList,
  JobOutput,
  LatestMaintenance,
  MaintenanceEvidence,
} from '@starter/schemas/jobs';
import { createId } from '@starter/utils';

/** Which jobs capability this deployment has. Absent means `disabled`. */
export const JOBS_PROFILE_DISABLED = 'disabled';
export const JOBS_PROFILE_ENCODE = 'encode';
export type JobsProfile = typeof JOBS_PROFILE_DISABLED | typeof JOBS_PROFILE_ENCODE;

/**
 * The private artifact reader.
 *
 * Not implemented in this PR: no object-storage binding is declared, so there are
 * no bytes to read. PR H implements this against private R2. It is a port rather
 * than an inline conditional so the ownership check stays in one place when the
 * real implementation lands.
 */
export interface JobArtifactReader {
  /**
   * The bytes for `outputKey`, or `null` when the object is genuinely absent.
   *
   * Must not be optimistic: returning a stream for an object that is not there
   * turns a retention bug into a truncated video rather than a 410.
   */
  read(outputKey: string, range: RangeRequest | null): Promise<ReadableStream<Uint8Array> | null>;
}

/** A bounded HTTP range for playback. `null` means the whole artifact. */
export interface RangeRequest {
  startInclusive: number;
  /** Inclusive, per RFC 9110. */
  endInclusive: number;
}

/** A byte range that is too large, malformed or unbounded. */
export type RangeRejection =
  | { ok: true; range: RangeRequest | null }
  | { ok: false; problem: string };

/** Largest slice one output request will serve. */
export const MAX_OUTPUT_RANGE_BYTES = 8 * 1024 * 1024;

/**
 * Parse a `Range` header against a known artifact length.
 *
 * Multi-range and suffix forms are refused rather than partially supported: an
 * answer that silently served the whole object for a header the caller believed
 * was a slice is how a player ends up downloading 10 MiB to play three seconds.
 */
export const parseByteRange = (header: string | null, totalBytes: number): RangeRejection => {
  if (header === null || header.trim().length === 0) {
    return { ok: true, range: null };
  }

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) {
    return { ok: false, problem: 'Only a single byte range is supported.' };
  }

  const [, rawStart, rawEnd] = match;
  if ((rawStart ?? '').length === 0 && (rawEnd ?? '').length === 0) {
    return { ok: false, problem: 'Only a single byte range is supported.' };
  }

  // Suffix form: `bytes=-N` means the last N bytes.
  if ((rawStart ?? '').length === 0) {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) {
      return { ok: false, problem: 'A suffix range must ask for at least one byte.' };
    }
    const start = Math.max(totalBytes - suffix, 0);
    return finish(start, totalBytes - 1, totalBytes);
  }

  const start = Number(rawStart);
  const end = rawEnd === undefined || rawEnd.length === 0 ? totalBytes - 1 : Number(rawEnd);
  return finish(start, end, totalBytes);
};

const finish = (start: number, end: number, totalBytes: number): RangeRejection => {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= totalBytes
  ) {
    return { ok: false, problem: 'That range is not satisfiable for this artifact.' };
  }
  if (end < start) {
    return { ok: false, problem: 'That range is not satisfiable for this artifact.' };
  }
  const clampedEnd = Math.min(end, totalBytes - 1);
  if (clampedEnd - start + 1 > MAX_OUTPUT_RANGE_BYTES) {
    return { ok: false, problem: 'That range is larger than this endpoint will serve.' };
  }
  return { ok: true, range: { startInclusive: start, endInclusive: clampedEnd } };
};

/** How a create request ended. The route maps each of these to a status. */
export type CreateJobOutcome =
  | { ok: true; job: JobDto; replayed: boolean }
  | {
      ok: false;
      code: JobAdmissionErrorCodeValue;
      /** Operator-facing detail. Never reaches a client body verbatim. */
      detail: string;
    };

export type ListJobsOutcome =
  | { ok: true; page: JobList }
  | { ok: false; code: 'invalid_cursor'; detail: string };

/** How a maintenance-evidence read ended. */
export type LatestMaintenanceOutcome =
  | { ok: true; latest: LatestMaintenance }
  | { ok: false; code: 'jobs_profile_disabled'; detail: string };

/** The bound for the general latest-runs query. Scheduled evidence is read separately. */
export const MAINTENANCE_EVIDENCE_ROWS = 20;

/**
 * Project a stored run onto the client DTO.
 *
 * The mapping is explicit field by field rather than a spread. A stored row
 * carries a run key — `manual:<requestId>` for an operator-triggered run — and a
 * spread would put an internal request id on a browser contract the first time
 * someone added a column to the table.
 */
export const toMaintenanceEvidence = (run: MaintenanceRun): MaintenanceEvidence => ({
  trigger: run.trigger,
  status: run.status,
  slot: run.slot,
  scheduledTime: run.scheduledTime,
  startedAt: run.startedAt,
  completedAt: run.completedAt,
  counts: {
    expiredSessions: run.expiredSessions,
    idleRateLimits: run.idleRateLimits,
    artifactsQueued: run.artifactsQueued,
    artifactsRetired: run.artifactsRetired,
    pendingDispatches: run.pendingDispatches,
  },
  errorCode: run.errorCode,
});

/** How an output read ended. */
export type OutputReadOutcome =
  | {
      ok: true;
      job: JobRecord;
      output: JobOutput;
      stream: ReadableStream<Uint8Array>;
      /** Null when the whole artifact was served. */
      range: RangeRequest | null;
    }
  | {
      ok: false;
      code: 'not_found' | 'output_not_ready' | 'output_expired' | 'output_unavailable';
      detail: string;
    }
  | { ok: false; code: 'range_not_satisfiable'; detail: string; totalBytes: number };

export interface JobsService {
  readonly profile: JobsProfile;
  create(
    ownerId: string,
    input: CreateEncodeJob,
    idempotencyKey: string,
  ): Promise<CreateJobOutcome>;
  list(
    ownerId: string,
    options?: { cursor?: string | null; limit?: number },
  ): Promise<ListJobsOutcome>;
  get(ownerId: string, jobId: string): Promise<JobDto | null>;
  readOutput(
    ownerId: string,
    jobId: string,
    rangeHeader: string | null,
  ): Promise<OutputReadOutcome>;
  /**
   * The most recent maintenance run, and the most recent *scheduled* one.
   *
   * Both, separately, because a single "last run" field is exactly how a manual
   * invocation gets reported as a natural scheduled firing. See
   * `LatestMaintenanceSchema`.
   */
  latestMaintenance(): Promise<LatestMaintenanceOutcome>;
  repository(): JobRepository;
}

/** The wire DTO. Deliberately lossy: see `JobDtoSchema`. */
export const toJobDto = (job: JobRecord, nowMs: number): JobDto => ({
  id: job.id,
  kind: job.kind,
  status: job.status,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  // Availability, not existence. An aged-out artifact is a `succeeded` job whose
  // bytes are gone, and the two must be distinguishable by a client.
  outputAvailable:
    job.status === 'succeeded' && job.output !== null && job.output.expiresAt > nowMs,
  errorCode: job.errorCode,
});

/** The dispatcher used while no compute profile is wired up. */
export const unconfiguredDispatchPort = (): WorkflowDispatchPort => createDisabledDispatchPort();

export const createJobsService = (options: {
  db: JobsDatabase;
  profile: JobsProfile;
  clock?: Clock;
  dispatch?: WorkflowDispatchPort;
  reader?: JobArtifactReader;
}): JobsService => {
  const clock = options.clock ?? systemClock;
  const dispatch = options.dispatch ?? createDisabledDispatchPort();
  const repository = createJobRepository(options.db, clock);
  const runs = createMaintenanceRunRepository(options.db, clock);

  return {
    profile: options.profile,
    repository: () => repository,

    async latestMaintenance() {
      if (options.profile !== JOBS_PROFILE_ENCODE) {
        return {
          ok: false,
          code: 'jobs_profile_disabled',
          detail:
            'This deployment has the jobs profile disabled, so there is no schedule to report.',
        };
      }

      const newestFirst = await runs.list(MAINTENANCE_EVIDENCE_ROWS);
      const newestScheduled = await runs.latestByTrigger('scheduled');

      return {
        ok: true,
        latest: {
          // The frozen cron. Not read from a binding: this repository's
          // `wrangler.jsonc` and its configuration test both assert this string,
          // and the jobs Worker that runs the schedule is a different Worker this
          // one cannot inspect at request time.
          schedule: MAINTENANCE_CRON,
          latest: newestFirst[0] === undefined ? null : toMaintenanceEvidence(newestFirst[0]),
          latestScheduled: newestScheduled === null ? null : toMaintenanceEvidence(newestScheduled),
          serverTime: clock.now(),
        },
      };
    },

    async create(ownerId, input, idempotencyKey) {
      if (options.profile !== JOBS_PROFILE_ENCODE) {
        return {
          ok: false,
          code: 'jobs_profile_disabled',
          detail: 'This deployment has the jobs profile disabled.',
        };
      }

      const admitted = await repository.createEncodeJob(
        ownerId,
        input,
        idempotencyKey,
        createId('job'),
      );

      if (!admitted.ok) {
        return admitted.reason === 'idempotency_conflict'
          ? {
              ok: false,
              code: 'idempotency_conflict',
              detail: 'That Idempotency-Key was already used for a different request body.',
            }
          : {
              ok: false,
              code: 'budget_exceeded',
              detail: describeBudget(admitted.budget),
            };
      }

      // A replay is complete on arrival: the first call already dispatched it, or
      // already recorded why it could not. Re-dispatching here would address the
      // same deterministic Workflow instance twice on every client retry.
      if (admitted.replayed) {
        return { ok: true, job: toJobDto(admitted.job, clock.now()), replayed: true };
      }

      const attemptId = createId('attempt');
      const outcome: DispatchOutcome = await dispatch.dispatch({
        jobId: admitted.job.id,
        workflowId: admitted.job.workflowId,
        fixture: admitted.job.fixture,
        preset: admitted.job.preset,
        attemptId,
      });

      if (outcome.ok) {
        await repository.markDispatched(admitted.job.id);
      } else {
        // The admission stays committed. This is the recoverable half of the
        // crash the design calls out: the job exists, is visible, and is owed a
        // dispatch, and `listPendingDispatches` will find it.
        await repository.markDispatchFailed(admitted.job.id, outcome.code);
      }

      // The job is reported as admitted either way. The caller gets a truthful 202
      // plus a job whose state is visible, and a dispatch refusal is discoverable
      // rather than hidden behind an error the caller cannot act on.
      return { ok: true, job: toJobDto(admitted.job, clock.now()), replayed: false };
    },

    async list(ownerId, listOptions = {}) {
      const parsed = parseJobCursor(listOptions.cursor ?? null);
      if (!parsed.ok) {
        return { ok: false, code: 'invalid_cursor', detail: parsed.problem };
      }
      const page = await repository.listJobsForOwner(ownerId, {
        ...(parsed.cursor === null ? {} : { cursor: parsed.cursor }),
        ...(listOptions.limit === undefined ? {} : { limit: listOptions.limit }),
      });
      const nowMs = clock.now();
      return {
        ok: true,
        page: {
          jobs: page.jobs.map((job) => toJobDto(job, nowMs)),
          nextCursor: page.nextCursor,
          serverTime: nowMs,
        },
      };
    },

    async get(ownerId, jobId) {
      const job = await repository.getJobForOwner(ownerId, jobId);
      // `null` for "not yours" and "not there" alike. A 403 would confirm the job
      // exists and turn the endpoint into an existence oracle.
      return job === null ? null : toJobDto(job, clock.now());
    },

    async readOutput(ownerId, jobId, rangeHeader) {
      const job = await repository.getJobForOwner(ownerId, jobId);
      if (job === null) {
        return {
          ok: false,
          code: 'not_found',
          detail: 'That job does not exist.',
        };
      }
      if (job.status !== 'succeeded' || job.output === null || job.outputKey === null) {
        return {
          ok: false,
          code: 'output_not_ready',
          detail: `That job is ${job.status}; it has no output.`,
        };
      }
      if (job.output.expiresAt <= clock.now()) {
        // 410, not 404: the artifact existed and its retention has elapsed. The
        // job still says `succeeded`, which is the truth about the encode.
        return {
          ok: false,
          code: 'output_expired',
          detail: 'That result has passed its retention window.',
        };
      }
      if (options.reader === undefined) {
        return {
          ok: false,
          code: 'output_unavailable',
          detail:
            'No private artifact store is bound to this deployment, so results cannot be served.',
        };
      }

      const parsed = parseByteRange(rangeHeader, job.output.bytes);
      if (!parsed.ok) {
        return {
          ok: false,
          code: 'range_not_satisfiable',
          detail: parsed.problem,
          totalBytes: job.output.bytes,
        };
      }

      const stream = await options.reader.read(job.outputKey, parsed.range);
      if (stream === null) {
        // The row claims an artifact the store does not have. Saying so is the
        // honest answer; serving an empty 200 would look like a zero-byte video.
        return {
          ok: false,
          code: 'output_unavailable',
          detail: 'That result is no longer stored.',
        };
      }

      return {
        ok: true,
        job,
        output: job.output,
        stream,
        range: parsed.range,
      };
    },
  };
};

const describeBudget = (budget: 'active' | 'hourly' | 'daily' | null): string => {
  switch (budget) {
    case 'hourly':
      return 'You have started your hourly job allowance.';
    case 'daily':
      return 'This environment has used its daily job allowance.';
    case 'active':
      return 'You already have a job that has not finished.';
    default:
      return 'The job budget is exhausted.';
  }
};

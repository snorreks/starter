// packages/backend/jobs/src/lib/job_repository.ts
//
// Job state on D1: admission, ownership-scoped reads, and fenced attempts.
//
// The admission decision
// ----------------------
// `createEncodeJob` is one statement. That is the entire design, and it is worth
// stating why the obvious version is wrong rather than merely slower:
//
//   const active = await countActive(ownerId);
//   const hourly = await countThisHour(ownerId);
//   if (active >= 1 || hourly >= 5) return refused;
//   await insert(job);          // ← three statements, four results
//
// Every one of those reads is a decision made on data another request may change
// before this one writes. Two requests that overlap see `active = 0` and both
// insert, and the "at most one active job per user" rule is enforced precisely
// when it is under the most load. The repository therefore encodes all four
// rules — one active job per user, five per user per rolling hour, fifty per
// environment per UTC day, one job per idempotency key — inside the inserting
// statement itself:
//
//   INSERT INTO jobs (...)
//   SELECT ?, ?, …, …, …
//   WHERE (SELECT count(*) … owner_id = ? AND created_at >= ?) < ?
//     AND (SELECT count(*) … created_at >= ?) < ?
//   ON CONFLICT DO NOTHING
//
// The `WHERE` clauses are correlated subqueries evaluated by SQLite as part of the
// same write, so they cannot be overtaken by a concurrent insert. `ON CONFLICT DO
// NOTHING` — with no conflict target on purpose — covers both uniqueness rules:
// the owner-scoped idempotency key *and* the partial unique index that makes
// "one active job per user" a property of the database rather than of a check
// somebody remembered to write.
//
// `changes === 1` means admitted. `changes === 0` means refused, and the refusal
// is then classified by reading, which is the right way round: the *decision* is
// atomic, and the reads that follow only explain it. Nothing in this file
// decides anything from a read it took before a write.
//
// Timestamps and the injected clock
// ---------------------------------
// Every method reads time from the `Clock` the caller injected, never from
// `Date.now()`. Two reasons, and the second is the one that matters: a budget
// window asserted by a test that sleeps for an hour is a test nobody runs, and a
// clock read from module scope in a Worker isolate is a clock the isolate froze.
//
// Columns are `integer(..., { mode: 'timestamp' })`, which in Drizzle stores
// *seconds*. `toEpochSeconds` is the single place that converts, because a
// schema that mixes seconds and milliseconds is a schema whose cutoffs are wrong
// in one direction and nobody can say which.
//
// Ownership
// ---------
// `getJobForOwner` and `listJobsForOwner` take an owner id and filter on it in
// the same statement as everything else. There is no "load by id, then compare"
// path, because that path is one refactor away from a leak and it still reads as
// a check in review.

import type {
  CreateEncodeJob,
  JobErrorCode,
  JobFixture,
  JobKind,
  JobOutput,
  JobPreset,
  JobStatus,
} from '@starter/schemas/jobs';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  JOB_FIXTURE_IDS,
  JOB_PRESET_IDS,
  MAX_ACTIVE_JOBS_PER_USER,
  MAX_JOB_ATTEMPTS,
  MAX_JOBS_PER_ENVIRONMENT_UTC_DAY,
  MAX_JOBS_PER_USER_HOUR,
  MAX_LISTED_JOBS,
} from '@starter/schemas/jobs';

import {
  DISPATCH_ERROR_CODES,
  DISPATCH_ERROR_MEANINGS,
  type DispatchErrorCode,
  MAX_DISPATCH_ATTEMPTS,
} from './dispatch_port.ts';
import { workflowIdFor } from './job_identity.ts';

const RETRYABLE_DISPATCH_CODES = DISPATCH_ERROR_CODES.filter(
  (code) => DISPATCH_ERROR_MEANINGS[code].retryable,
);
const RETRYABLE_DISPATCH_SQL = RETRYABLE_DISPATCH_CODES.map(() => '?').join(', ');

// -----------------------------------------------------------------------------
// Database surface
// -----------------------------------------------------------------------------

/** The row count D1 reports for a write. `changes` is the number of rows touched. */
export interface JobWriteMeta {
  changes: number;
}

export interface JobStatementResult<T> {
  results: T[];
  meta: JobWriteMeta;
}

/**
 * The slice of `D1Database` this repository uses.
 *
 * Named rather than taking `D1Database` directly for one concrete reason: the
 * unit lane runs the *real* SQL on `bun:sqlite`, behind a small adapter. A
 * repository typed against `D1Database` could only be tested inside workerd, and
 * the statements here are the part of this file most worth testing outside it.
 * `D1Database` satisfies this interface structurally, so the web Worker passes
 * its binding unchanged.
 */
export interface JobsDatabase {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T = Record<string, unknown>>(): Promise<JobStatementResult<T>>;
      /** `results` is empty for a write, but declared so a real D1 result fits. */
      run(): Promise<{ results: unknown[]; meta: JobWriteMeta }>;
      first<T = unknown>(columnName?: string): Promise<T | null>;
    };
  };
}

/** The only time source in this file. Injected so tests do not have to sleep. */
export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

/** The default clock. Passed explicitly everywhere rather than defaulted. */
export const systemClock: Clock = { now: () => Date.now() };

/** Milliseconds -> the epoch *seconds* the `timestamp` columns store. */
const toEpochSeconds = (ms: number): number => Math.floor(ms / 1000);

/** One hour, for the rolling per-user window. */
const HOUR_MS = 60 * 60 * 1000;

/**
 * Start of the UTC day containing `ms`, in epoch milliseconds.
 *
 * `Math.floor(ms / 86400000) * 86400000` is the UTC day boundary precisely
 * because epoch time has no timezone: a day is 86400000 ms long from 1970-01-01T00:00:00Z
 * onwards, so integer division by that is the UTC midnight. `new Date().setUTCHours(0,0,0,0)`
 * computes the same thing through three timezone-dependent operations, and this
 * code runs on a Worker with no `TZ` guarantee at all.
 */
export const startOfUtcDay = (ms: number): number => Math.floor(ms / 86_400_000) * 86_400_000;

// -----------------------------------------------------------------------------
// Rows and records
// -----------------------------------------------------------------------------

interface JobRow {
  id: string;
  owner_id: string;
  kind: string;
  status: string;
  fixture: string;
  preset: string;
  idempotency_key: string;
  request_fingerprint: string;
  workflow_id: string;
  dispatch_state: string;
  dispatch_attempts: number;
  dispatch_error: string | null;
  dispatched_at: number | null;
  active_attempt_id: string | null;
  lease_expires_at: number | null;
  attempt_count: number;
  output_key: string | null;
  output_bytes: number | null;
  output_sha256: string | null;
  output_container_format: string | null;
  output_video_codec: string | null;
  output_width: number | null;
  output_height: number | null;
  output_duration_ms: number | null;
  output_expires_at: number | null;
  error_code: string | null;
  // Seconds, because the columns are `mode: 'timestamp'`.
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

/**
 * The job, with its private storage key intact.
 *
 * Deliberately *not* the wire DTO. `outputKey` is a private R2 key and the owner
 * id is the authorization subject; a type that carried both and was accidentally
 * returned from a route would leak the first and re-open the second. `toJobDto`
 * is the only way to become a DTO, and it is one call away in review.
 */
export interface JobRecord {
  id: string;
  ownerId: string;
  kind: JobKind;
  status: JobStatus;
  fixture: JobFixture;
  preset: JobPreset;
  idempotencyKey: string;
  requestFingerprint: string;
  /** Stable across retries and crashes; derived from the job id. */
  workflowId: string;
  dispatchState: 'pending' | 'dispatched' | 'dispatch_failed';
  dispatchAttempts: number;
  dispatchError: string | null;
  activeAttemptId: string | null;
  attemptCount: number;
  /** Private R2 key, or null. Server plane only. */
  outputKey: string | null;
  output: JobOutput | null;
  errorCode: JobErrorCode | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

const ms = (seconds: number | null): number | null => (seconds === null ? null : seconds * 1000);

const toRecord = (row: JobRow): JobRecord => {
  const fixture = JOB_FIXTURE_IDS.find((value) => value === row.fixture);
  const preset = JOB_PRESET_IDS.find((value) => value === row.preset);
  if (fixture === undefined || preset === undefined) {
    throw new Error('Job has an unknown fixture or preset.');
  }
  const hasOutput =
    row.output_key !== null &&
    row.output_bytes !== null &&
    row.output_sha256 !== null &&
    row.output_container_format !== null &&
    row.output_video_codec !== null &&
    row.output_width !== null &&
    row.output_height !== null &&
    row.output_duration_ms !== null &&
    row.output_expires_at !== null;

  return {
    id: row.id,
    ownerId: row.owner_id,
    // CHECK constraints protect kind and status; fixture and preset are validated above.
    kind: row.kind as JobKind,
    status: row.status as JobStatus,
    fixture,
    preset,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    workflowId: row.workflow_id,
    dispatchState: row.dispatch_state as JobRecord['dispatchState'],
    dispatchAttempts: row.dispatch_attempts,
    dispatchError: row.dispatch_error,
    activeAttemptId: row.active_attempt_id,
    attemptCount: row.attempt_count,
    outputKey: row.output_key,
    output: hasOutput
      ? {
          bytes: row.output_bytes as number,
          sha256: row.output_sha256 as string,
          containerFormat: row.output_container_format as string,
          videoCodec: row.output_video_codec as string,
          width: row.output_width as number,
          height: row.output_height as number,
          durationMs: row.output_duration_ms as number,
          expiresAt: (row.output_expires_at as number) * 1000,
        }
      : null,
    errorCode: row.error_code as JobErrorCode | null,
    createdAt: row.created_at * 1000,
    updatedAt: row.updated_at * 1000,
    completedAt: ms(row.completed_at),
  };
};

const JOB_COLUMNS = `
  id, owner_id, kind, status, fixture, preset, idempotency_key, request_fingerprint,
  workflow_id, dispatch_state, dispatch_attempts, dispatch_error, dispatched_at,
  active_attempt_id, lease_expires_at, attempt_count,
  output_key, output_bytes, output_sha256, output_container_format, output_video_codec,
  output_width, output_height, output_duration_ms, output_expires_at, error_code,
  created_at, updated_at, completed_at`;

/**
 * The canonical request body, stored verbatim as the replay fingerprint.
 *
 * A hash would buy nothing here and cost the one thing worth having: with two
 * frozen enums, the canonical form is at most forty bytes, and a reviewer can
 * read the conflict rule off the column. `JSON.stringify` over a fixed key order
 * is stable because the object is built here, not parsed from the body.
 */
export const requestFingerprint = (input: CreateEncodeJob): string =>
  JSON.stringify({ fixture: input.fixture, preset: input.preset });

/**
 * The Workflow instance id for a job.
 *
 * Re-exported from `./job_identity.ts`, where it lives with the reason it is
 * derived rather than chosen. Every existing importer of `workflowIdFor` keeps
 * working; the module boundary exists so the dispatch port can enforce the
 * derivation without importing the repository it is imported by.
 */
export { workflowIdFor };

// -----------------------------------------------------------------------------
// Outcomes
// -----------------------------------------------------------------------------

/** Which budget refused an admission. Reported so a 429 can name itself. */
export type AdmissionBudget = 'active' | 'hourly' | 'daily';

export type CreateEncodeJobOutcome =
  | {
      ok: true;
      job: JobRecord;
      /**
       * True when this key already admitted this exact request.
       *
       * A replay is a success, not a conflict: the caller retried, and the retry
       * must not create a second job or spend a second unit of budget.
       */
      replayed: boolean;
    }
  | {
      ok: false;
      reason: 'idempotency_conflict' | 'budget_exceeded';
      budget: AdmissionBudget | null;
    };

/** Why an attempt could not take the lease. */
export type AttemptClaimRefusal =
  | 'not_found'
  | 'not_claimable'
  | 'lease_held'
  | 'attempts_exhausted';

export type AttemptClaim =
  | { ok: true; job: JobRecord }
  | { ok: false; reason: AttemptClaimRefusal };

/**
 * Why a terminal write was refused.
 *
 * `fenced` is the important one. It means this attempt is no longer the job's
 * `active_attempt_id` — it lost its lease, or its result was already superseded —
 * and its write matched no rows. That is the fence working, not an error.
 */
export type AttemptTransition =
  | { ok: true; job: JobRecord }
  | { ok: false; reason: 'not_found' | 'fenced' };

/** What a successful encode commits. Bytes live in private storage; this is metadata. */
export interface JobOutputCommit {
  /** Private storage key the caller already wrote the bytes under. */
  key: string;
  bytes: number;
  sha256: string;
  containerFormat: string;
  videoCodec: string;
  width: number;
  height: number;
  durationMs: number;
  /** Epoch milliseconds at which retention removes the artifact. */
  expiresAt: number;
}

export interface ListJobsOptions {
  /**
   * Where the next page starts. Parse a client's `cursor` with
   * `parseJobCursor` before passing it — the raw token carries a delimiter and
   * must not be bound into an integer comparison, where SQLite orders every text
   * value after every integer and the predicate would be true for every row.
   */
  cursor?: JobCursor | null;
  /** Clamped to `MAX_LISTED_JOBS`. */
  limit?: number;
}

/**
 * A position in one owner's listing.
 *
 * The pair is needed because `created_at` is second-granular, so two jobs created
 * in the same second are indistinguishable by timestamp alone and a cursor on the
 * timestamp would skip one of them. `id` breaks the tie, and the pair is unique,
 * which makes the ordering total.
 */
export interface JobCursor {
  /** Epoch **seconds**, matching the stored column. */
  createdAtSeconds: number;
  id: string;
}

/** Render a job's position as the opaque token a client echoes back. */
export const formatJobCursor = (job: { createdAt: number; id: string }): string =>
  `${Math.floor(job.createdAt / 1000)}:${job.id}`;

export type ParsedJobCursor =
  | { ok: true; cursor: JobCursor | null }
  | { ok: false; problem: string };

/**
 * Validate a client-supplied cursor.
 *
 * Parsed at the boundary rather than inside the repository, because a cursor is
 * untrusted input: an unparseable one is a 400 at the route, not a 500 from a
 * library and not an empty list that looks like the end of the data.
 */
export const parseJobCursor = (raw: string | null | undefined): ParsedJobCursor => {
  if (raw === null || raw === undefined || raw.length === 0) {
    return { ok: true, cursor: null };
  }
  // `lastIndexOf`, not `indexOf`: a job id may itself contain a colon in a future
  // migration, and taking the *last* separator keeps this correct when it does.
  const separator = raw.lastIndexOf(':');
  if (separator <= 0) {
    return { ok: false, problem: 'A cursor must be "<epoch-seconds>:<job-id>".' };
  }
  const seconds = raw.slice(0, separator);
  const id = raw.slice(separator + 1);
  if (!/^\d+$/.test(seconds) || id.length === 0 || id.length > 64) {
    return { ok: false, problem: 'A cursor must be "<epoch-seconds>:<job-id>".' };
  }
  return { ok: true, cursor: { createdAtSeconds: Number(seconds), id } };
};

export interface JobListPage {
  jobs: JobRecord[];
  nextCursor: string | null;
}

export interface JobAdmissionBounds {
  maxActivePerUser: number;
  maxPerUserPerHour: number;
  maxPerEnvironmentPerUtcDay: number;
}

/** The frozen demo policy. Overridable in tests, never from a request. */
export const DEFAULT_ADMISSION_BOUNDS: JobAdmissionBounds = {
  maxActivePerUser: MAX_ACTIVE_JOBS_PER_USER,
  maxPerUserPerHour: MAX_JOBS_PER_USER_HOUR,
  maxPerEnvironmentPerUtcDay: MAX_JOBS_PER_ENVIRONMENT_UTC_DAY,
};

export interface JobRepository {
  /**
   * Admit one encode job, or explain why it was refused.
   *
   * `ownerId` is a parameter and never part of `input`: the create schema is
   * closed, so a body carrying `ownerId` cannot get this far, and a client has no
   * way to name whose job to create.
   */
  createEncodeJob(
    ownerId: string,
    input: CreateEncodeJob,
    idempotencyKey: string,
    jobId: string,
  ): Promise<CreateEncodeJobOutcome>;

  /** One owner's job. `null` for a job that does not exist *for this owner*. */
  getJobForOwner(ownerId: string, jobId: string): Promise<JobRecord | null>;

  /** One owner's jobs, newest first, one bounded page. */
  listJobsForOwner(ownerId: string, options?: ListJobsOptions): Promise<JobListPage>;

  /** Take the job's lease for `attemptId`. One statement, one winner. */
  claimAttempt(jobId: string, attemptId: string, leaseUntilMs: number): Promise<AttemptClaim>;

  /**
   * Commit a successful encode.
   *
   * Succeeds only while `attemptId` still holds the lease and the job is still
   * `running`. A stale attempt matches no rows and is reported as fenced.
   */
  completeAttempt(
    jobId: string,
    attemptId: string,
    output: JobOutputCommit,
  ): Promise<AttemptTransition>;

  /** Commit a failed attempt, under the same fence as `completeAttempt`. */
  failAttempt(jobId: string, attemptId: string, code: JobErrorCode): Promise<AttemptTransition>;

  /** Record that the Workflow call succeeded. Idempotent. */
  markDispatched(jobId: string): Promise<boolean>;

  /** Persist the frozen error code, which determines retryability during recovery. */
  markDispatchFailed(jobId: string, code: DispatchErrorCode): Promise<boolean>;

  /** Admitted jobs whose Workflow was never started. Bounded. */
  listPendingDispatches(limit: number): Promise<JobRecord[]>;

  /** Terminal jobs whose artifact is past `cutoffMs`, oldest first. Bounded. */
  listExpiredArtifacts(cutoffMs: number, limit: number): Promise<JobRecord[]>;

  /** Queue a job's artifact for byte deletion by the storage owner. Idempotent. */
  enqueueArtifactRetirement(jobId: string, cutoffMs: number): Promise<boolean>;

  /** Terminalize abandoned active jobs without disturbing a live lease. */
  failStaleJobs(cutoffMs: number, limit: number): Promise<number>;

  recordArtifactRetirementRetry(jobId: string): Promise<boolean>;

  /** The queued retirements, fewest runs then oldest cutoff first. Bounded. */
  listArtifactRetirements(
    limit: number,
  ): Promise<Array<{ jobId: string; outputKey: string; runs: number; cutoffAt: number }>>;

  /** Drop a retirement row after its bytes are gone. Reports whether one existed. */
  completeArtifactRetirement(jobId: string): Promise<boolean>;

  /** Clear the artifact columns once the bytes are gone. */
  clearJobOutput(jobId: string): Promise<boolean>;
}

// -----------------------------------------------------------------------------
// SQL
// -----------------------------------------------------------------------------

/**
 * The whole admission decision.
 *
 * Read it as four guards inside one statement:
 *
 *   WHERE (SELECT count(*) FROM jobs WHERE owner_id = ? AND created_at >= ?) < ?   -- hourly
 *     AND (SELECT count(*) FROM jobs WHERE created_at >= ?) < ?                    -- daily, UTC
 *   ON CONFLICT DO NOTHING                                                         -- active + key
 *
 * The hourly window is *rolling* (`now - 1h`), which is what "five jobs per hour"
 * means to a user; the daily window is a *calendar* UTC day, which is what makes
 * "fifty per environment per UTC day" a figure an operator can reason about
 * against a usage dashboard.
 *
 * The active-job cap is not in the `WHERE` on purpose: it cannot be a count,
 * because a count would race. It is the partial unique index
 * `jobs_owner_active_uq`, and `ON CONFLICT DO NOTHING` is what turns a violation
 * of it into `changes === 0` rather than a thrown error.
 *
 * Repeated `?` placeholders are bound rather than inlined for the same reason
 * `d1_rate_limit.ts` does it: the clock is read many times in one statement and
 * every occurrence has to be the same instant.
 */
const ADMIT_SQL = `
INSERT INTO jobs (
  id, owner_id, kind, status, fixture, preset, idempotency_key, request_fingerprint,
  workflow_id, dispatch_state, dispatch_attempts, dispatch_error, dispatched_at,
  active_attempt_id, lease_expires_at, attempt_count,
  output_key, output_bytes, output_sha256, output_container_format, output_video_codec,
  output_width, output_height, output_duration_ms, output_expires_at, error_code,
  created_at, updated_at, completed_at
)
SELECT ?, ?, 'encode', 'pending', ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL,
       NULL, NULL, 0,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
       ?, ?, NULL
WHERE (SELECT count(*) FROM jobs WHERE owner_id = ? AND created_at >= ?) < ?
  AND (SELECT count(*) FROM jobs WHERE created_at >= ?) < ?
ON CONFLICT DO NOTHING
`;

/**
 * Take the lease.
 *
 * One statement decides three things at once, which is the only reason this is
 * correct: the job exists, it is claimable, nobody else holds an unexpired lease,
 * and it has attempts left. A read-then-update would let two attempts both read
 * `attempt_count = 0` and both increment.
 *
 * `status = 'pending' OR status = 'running'` — a `running` job with an expired
 * lease is claimable, which is exactly how a crashed attempt is taken over. A
 * `succeeded` or `failed` job is not, so a terminal job can never be reopened by a
 * late arrival.
 */
const CLAIM_SQL = `
UPDATE jobs
SET status = 'running',
    active_attempt_id = ?,
    lease_expires_at = ?,
    attempt_count = attempt_count + 1,
    updated_at = ?
WHERE id = ?
  AND (status = 'pending' OR status = 'running')
  AND (active_attempt_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
  AND attempt_count < ?
RETURNING ${JOB_COLUMNS}
`;

/**
 * Commit a success, fenced.
 *
 * Three conditions, all required: the job exists, *this* attempt holds the lease,
 * and the job is still `running`. The third is what makes a committed success
 * immutable — once `completeAttempt` wins, `status` is `succeeded`, and neither
 * this statement nor `failAttempt` can match it again.
 */
const COMPLETE_SQL = `
UPDATE jobs
SET status = 'succeeded',
    error_code = NULL,
    output_key = ?, output_bytes = ?, output_sha256 = ?, output_container_format = ?,
    output_video_codec = ?, output_width = ?, output_height = ?, output_duration_ms = ?,
    output_expires_at = ?,
    active_attempt_id = NULL,
    lease_expires_at = NULL,
    completed_at = ?,
    updated_at = ?
WHERE id = ? AND active_attempt_id = ? AND status = 'running'
RETURNING ${JOB_COLUMNS}
`;

/** Commit a failure, under the same fence as `COMPLETE_SQL`. */
const FAIL_SQL = `
UPDATE jobs
SET status = 'failed',
    error_code = ?,
    active_attempt_id = NULL,
    lease_expires_at = NULL,
    completed_at = ?,
    updated_at = ?
WHERE id = ? AND active_attempt_id = ? AND status = 'running'
RETURNING ${JOB_COLUMNS}
`;

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

export const createJobRepository = (
  db: JobsDatabase,
  clock: Clock,
  bounds: JobAdmissionBounds = DEFAULT_ADMISSION_BOUNDS,
): JobRepository => {
  const findByKey = async (ownerId: string, idempotencyKey: string): Promise<JobRow | null> => {
    const { results } = await db
      .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE owner_id = ? AND idempotency_key = ?`)
      .bind(ownerId, idempotencyKey)
      .all<JobRow>();
    const row = results[0];
    return row ?? null;
  };

  /**
   * Which budget said no.
   *
   * Only ever called after the inserting statement refused, so it explains a
   * decision rather than making one. Two refused requests for the same user in the
   * same instant can be classified differently, and both classifications are
   * true: the second one was refused by the active-job index *because* the first
   * one had just been admitted.
   */
  const classifyRefusal = async (ownerId: string, nowMs: number): Promise<AdmissionBudget> => {
    const since = await db
      .prepare('SELECT count(*) AS n FROM jobs WHERE owner_id = ? AND created_at >= ?')
      .bind(ownerId, toEpochSeconds(nowMs - HOUR_MS))
      .first<{ n: number }>();
    if ((since?.n ?? 0) >= bounds.maxPerUserPerHour) {
      return 'hourly';
    }

    const daily = await db
      .prepare('SELECT count(*) AS n FROM jobs WHERE created_at >= ?')
      .bind(toEpochSeconds(startOfUtcDay(nowMs)))
      .first<{ n: number }>();
    if ((daily?.n ?? 0) >= bounds.maxPerEnvironmentPerUtcDay) {
      return 'daily';
    }

    // Neither count is at its cap, so the refusal came from the partial unique
    // index: this owner already has a `pending` or `running` job.
    return 'active';
  };

  /**
   * Why a terminal write matched no rows.
   *
   * `not_found` versus `fenced` is the distinction a caller acts on: a missing job
   * is worth a warning, a fenced write is the system working. Both are reads of a
   * row this attempt already failed to update, so they describe a decision that
   * has been made rather than one still to take.
   */
  const classifyFence = async (jobId: string): Promise<'not_found' | 'fenced'> => {
    const row = await db
      .prepare('SELECT active_attempt_id FROM jobs WHERE id = ?')
      .bind(jobId)
      .first<{ active_attempt_id: string | null }>();
    return row === null ? 'not_found' : 'fenced';
  };

  return {
    async createEncodeJob(ownerId, input, idempotencyKey, jobId) {
      if (idempotencyKey.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
        // Reached only if a caller skipped schema validation. Refusing here rather
        // than truncating: a truncated key collides with a different key.
        return { ok: false, reason: 'idempotency_conflict', budget: null };
      }

      const nowMs = clock.now();
      const nowSec = toEpochSeconds(nowMs);
      const fingerprint = requestFingerprint(input);

      // The fast path for a retry: a key already admitted this exact body returns
      // the stored job without touching the budget at all. This is a read, and it
      // is only a shortcut — the statement below is what actually guarantees it,
      // so a racing first request cannot slip past it.
      const existing = await findByKey(ownerId, idempotencyKey);
      if (existing !== null) {
        return existing.request_fingerprint === fingerprint
          ? { ok: true, job: toRecord(existing), replayed: true }
          : { ok: false, reason: 'idempotency_conflict', budget: null };
      }

      const { meta } = await db
        .prepare(ADMIT_SQL)
        .bind(
          jobId,
          ownerId,
          input.fixture,
          input.preset,
          idempotencyKey,
          fingerprint,
          workflowIdFor(jobId),
          nowSec,
          nowSec,
          ownerId,
          toEpochSeconds(nowMs - HOUR_MS),
          bounds.maxPerUserPerHour,
          toEpochSeconds(startOfUtcDay(nowMs)),
          bounds.maxPerEnvironmentPerUtcDay,
        )
        .run();

      if (meta.changes === 1) {
        const admitted = await findByKey(ownerId, idempotencyKey);
        // The row this statement just wrote. A null here would mean the database
        // disagrees with its own reported change count, which is a fault worth a
        // loud failure rather than a plausible-looking DTO.
        if (admitted === null) {
          throw new Error(
            `Job ${jobId} was admitted by the inserting statement but could not be read back.`,
          );
        }
        return { ok: true, job: toRecord(admitted), replayed: false };
      }

      // Refused. A same-key row means this is a replay or a conflict; no row means
      // a budget said no. Which key the caller used is the only question, so
      // asking it is not a second opinion about the decision — it is the label.
      const after = await findByKey(ownerId, idempotencyKey);
      if (after !== null) {
        return after.request_fingerprint === fingerprint
          ? { ok: true, job: toRecord(after), replayed: true }
          : { ok: false, reason: 'idempotency_conflict', budget: null };
      }

      return {
        ok: false,
        reason: 'budget_exceeded',
        budget: await classifyRefusal(ownerId, nowMs),
      };
    },

    async getJobForOwner(ownerId, jobId) {
      const row = await db
        .prepare(`SELECT ${JOB_COLUMNS} FROM jobs WHERE owner_id = ? AND id = ?`)
        .bind(ownerId, jobId)
        .first<JobRow>();
      return row === null ? null : toRecord(row);
    },

    async listJobsForOwner(ownerId, options) {
      // Both bounds clamped here rather than at the call site, because a limit is
      // a database-protection fact and a caller that forgets it should get the
      // safe value, not an unbounded scan.
      const limit = Math.min(Math.max(options?.limit ?? MAX_LISTED_JOBS, 1), MAX_LISTED_JOBS);
      const cursor = options?.cursor ?? null;
      const cursorSeconds = cursor?.createdAtSeconds ?? null;
      const cursorId = cursor?.id ?? null;

      // The cursor is the previous page's last `created_at` plus its id. Two jobs
      // can share a second, and a bare timestamp would drop the second of the
      // two — so the id breaks the tie and the pair is unique, which makes the
      // ordering total.
      const { results } = await db
        .prepare(
          `SELECT ${JOB_COLUMNS} FROM jobs
           WHERE owner_id = ?
             AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        )
        .bind(
          ownerId,
          cursorSeconds,
          cursorSeconds,
          cursorSeconds,
          cursorId,
          // One more than asked for: the presence of an extra row is how the
          // caller learns there is a next page without a second COUNT query.
          limit + 1,
        )
        .all<JobRow>();

      const page = results.slice(0, limit).map(toRecord);
      const hasMore = results.length > limit;
      const last = page.at(-1);
      return {
        jobs: page,
        // Seconds, because `created_at` is seconds. Encoding milliseconds here
        // would make the cursor a number that is always greater than every row's
        // timestamp, so the second page would be the first page again — a cursor
        // that silently ignores itself.
        nextCursor: hasMore && last !== undefined ? formatJobCursor(last) : null,
      };
    },

    async claimAttempt(jobId, attemptId, leaseUntilMs) {
      const nowSec = toEpochSeconds(clock.now());
      const { results } = await db
        .prepare(CLAIM_SQL)
        .bind(attemptId, toEpochSeconds(leaseUntilMs), nowSec, jobId, nowSec, MAX_JOB_ATTEMPTS)
        .all<JobRow>();

      const row = results[0];
      if (row !== undefined) {
        return { ok: true, job: toRecord(row) };
      }

      // No row changed. The single statement refused, so the reads below name
      // which of its four conditions failed — they are explanations, not checks.
      const current = await db
        .prepare(
          'SELECT status, active_attempt_id, lease_expires_at, attempt_count FROM jobs WHERE id = ?',
        )
        .bind(jobId)
        .first<{
          status: string;
          active_attempt_id: string | null;
          lease_expires_at: number | null;
          attempt_count: number;
        }>();

      if (current === null) {
        return { ok: false, reason: 'not_found' };
      }
      if (current.status !== 'pending' && current.status !== 'running') {
        return { ok: false, reason: 'not_claimable' };
      }
      if (
        current.active_attempt_id !== null &&
        current.lease_expires_at !== null &&
        current.lease_expires_at > nowSec
      ) {
        return { ok: false, reason: 'lease_held' };
      }
      if (current.attempt_count >= MAX_JOB_ATTEMPTS) {
        await db
          .prepare(`UPDATE jobs SET status = 'failed', error_code = 'attempts_exhausted',
          active_attempt_id = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND status IN ('pending', 'running') AND attempt_count >= ?
            AND (active_attempt_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`)
          .bind(nowSec, nowSec, jobId, MAX_JOB_ATTEMPTS, nowSec)
          .run();
        return { ok: false, reason: 'attempts_exhausted' };
      }
      // The lease is free and the job is claimable, so the statement refused for a
      // reason this process cannot see. Said plainly rather than guessed at.
      return { ok: false, reason: 'not_claimable' };
    },

    async completeAttempt(jobId, attemptId, output) {
      const nowSec = toEpochSeconds(clock.now());
      const { results } = await db
        .prepare(COMPLETE_SQL)
        .bind(
          output.key,
          output.bytes,
          output.sha256,
          output.containerFormat,
          output.videoCodec,
          output.width,
          output.height,
          output.durationMs,
          toEpochSeconds(output.expiresAt),
          nowSec,
          nowSec,
          jobId,
          attemptId,
        )
        .all<JobRow>();

      const row = results[0];
      if (row !== undefined) {
        return { ok: true, job: toRecord(row) };
      }
      return { ok: false, reason: await classifyFence(jobId) };
    },

    async failAttempt(jobId, attemptId, code) {
      const nowSec = toEpochSeconds(clock.now());
      const { results } = await db
        .prepare(FAIL_SQL)
        .bind(code, nowSec, nowSec, jobId, attemptId)
        .all<JobRow>();

      const row = results[0];
      if (row !== undefined) {
        return { ok: true, job: toRecord(row) };
      }
      return { ok: false, reason: await classifyFence(jobId) };
    },

    async markDispatched(jobId) {
      const nowSec = toEpochSeconds(clock.now());
      const { meta } = await db
        .prepare(
          `UPDATE jobs SET dispatch_state = 'dispatched', dispatch_error = NULL,
             dispatched_at = ?, updated_at = ?
           WHERE id = ? AND dispatch_state != 'dispatched'`,
        )
        .bind(nowSec, nowSec, jobId)
        .run();
      return meta.changes === 1;
    },

    async markDispatchFailed(jobId, code) {
      const nowSec = toEpochSeconds(clock.now());
      const { meta } = await db
        .prepare(
          `UPDATE jobs SET dispatch_state = 'dispatch_failed', dispatch_error = ?,
             dispatch_attempts = dispatch_attempts + 1, updated_at = ?
           WHERE id = ?`,
        )
        // Persist the code whose retryability is defined in DISPATCH_ERROR_MEANINGS.
        // Nothing a provider returned is stored here.
        .bind(code.slice(0, 64), nowSec, jobId)
        .run();
      return meta.changes === 1;
    },

    async listPendingDispatches(limit) {
      const { results } = await db
        .prepare(
          `SELECT ${JOB_COLUMNS} FROM jobs
           WHERE error_code IS NULL
             AND (dispatch_state = 'pending' OR (dispatch_state = 'dispatch_failed'
               AND dispatch_attempts < ? AND dispatch_error IN (${RETRYABLE_DISPATCH_SQL})))
           ORDER BY created_at ASC, id ASC
           LIMIT ?`,
        )
        .bind(MAX_DISPATCH_ATTEMPTS, ...RETRYABLE_DISPATCH_CODES, clampLimit(limit))
        .all<JobRow>();
      return results.map(toRecord);
    },

    async failStaleJobs(cutoffMs, limit) {
      const nowSec = toEpochSeconds(clock.now());
      const { meta } = await db
        .prepare(`UPDATE jobs
        SET status = 'failed',
            error_code = CASE WHEN attempt_count >= ? THEN 'attempts_exhausted' ELSE 'internal_error' END,
            active_attempt_id = NULL, lease_expires_at = NULL, completed_at = ?, updated_at = ?
        WHERE id IN (SELECT id FROM jobs
          WHERE status IN ('pending', 'running')
            AND (active_attempt_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
            AND (attempt_count >= ? OR (dispatch_state = 'dispatch_failed'
              AND (updated_at <= ? OR dispatch_attempts >= ?
                OR dispatch_error IS NULL OR dispatch_error NOT IN (${RETRYABLE_DISPATCH_SQL}))))
          ORDER BY updated_at ASC, id ASC LIMIT ?)`)
        .bind(
          MAX_JOB_ATTEMPTS,
          nowSec,
          nowSec,
          nowSec,
          MAX_JOB_ATTEMPTS,
          toEpochSeconds(cutoffMs),
          MAX_DISPATCH_ATTEMPTS,
          ...RETRYABLE_DISPATCH_CODES,
          clampLimit(limit),
        )
        .run();
      return meta.changes;
    },

    async recordArtifactRetirementRetry(jobId) {
      const { meta } = await db
        .prepare('UPDATE job_artifact_retirements SET runs = runs + 1 WHERE job_id = ?')
        .bind(jobId)
        .run();
      return meta.changes === 1;
    },

    async listExpiredArtifacts(cutoffMs, limit) {
      const { results } = await db
        .prepare(
          `SELECT ${JOB_COLUMNS} FROM jobs
           WHERE output_expires_at IS NOT NULL AND output_expires_at <= ?
             AND NOT EXISTS (SELECT 1 FROM job_artifact_retirements WHERE job_id = jobs.id)
           ORDER BY output_expires_at ASC, id ASC
           LIMIT ?`,
        )
        .bind(toEpochSeconds(cutoffMs), clampLimit(limit))
        .all<JobRow>();
      return results.map(toRecord);
    },

    async enqueueArtifactRetirement(jobId, cutoffMs) {
      const { meta } = await db
        .prepare(
          `INSERT INTO job_artifact_retirements (job_id, output_key, runs, cutoff_at)
           SELECT id, output_key, 0, ? FROM jobs WHERE id = ? AND output_key IS NOT NULL
           ON CONFLICT(job_id) DO NOTHING`,
        )
        .bind(toEpochSeconds(cutoffMs), jobId)
        .run();
      return meta.changes === 1;
    },

    async listArtifactRetirements(limit) {
      const { results } = await db
        .prepare(
          `SELECT job_id, output_key, runs, cutoff_at FROM job_artifact_retirements
           ORDER BY runs ASC, cutoff_at ASC, job_id ASC LIMIT ?`,
        )
        .bind(clampLimit(limit))
        .all<{ job_id: string; output_key: string; runs: number; cutoff_at: number }>();
      return results.map((row) => ({
        jobId: row.job_id,
        outputKey: row.output_key,
        runs: row.runs,
        cutoffAt: row.cutoff_at * 1000,
      }));
    },

    async completeArtifactRetirement(jobId) {
      const { meta } = await db
        .prepare('DELETE FROM job_artifact_retirements WHERE job_id = ?')
        .bind(jobId)
        .run();
      return meta.changes === 1;
    },

    async clearJobOutput(jobId) {
      const { meta } = await db
        .prepare(
          `UPDATE jobs SET
             output_key = NULL, output_bytes = NULL, output_sha256 = NULL,
             output_container_format = NULL, output_video_codec = NULL,
             output_width = NULL, output_height = NULL,
             output_duration_ms = NULL, output_expires_at = NULL,
             updated_at = ?
           WHERE id = ?`,
        )
        .bind(toEpochSeconds(clock.now()), jobId)
        .run();
      return meta.changes === 1;
    },
  };
};

const clampLimit = (limit: number): number =>
  Math.min(Math.max(Math.floor(limit), 1), MAX_LISTED_JOBS);

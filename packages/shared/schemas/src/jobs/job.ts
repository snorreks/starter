// packages/shared/schemas/src/jobs/job.ts
//
// The public job contract: what a client may ask for, and what it may read back.
//
// Everything here is a *closed* schema. `additionalProperties: false` is the
// mechanism, and it is load-bearing in three separate places:
//
//   1. `CreateEncodeJobSchema` has no `ownerId`. A client that sent one would be
//      naming whose job to create, and the server derives the owner from the
//      session instead. A closed schema makes that an outright refusal rather
//      than an accepted-and-ignored field.
//   2. `CreateEncodeJobSchema` has no file URL and no ffmpeg argument. The only
//      input is a named fixture and a named preset, both frozen, so "upload your
//      own video" is not a request this API can express.
//   3. `JobDtoSchema` carries no private R2 key, no raw stderr and no provider
//      error text. Output metadata is a separate, separately versioned DTO.
//
// The bounds below are the demo's admission policy, not a suggestion. They are
// constants with a home so that the repository, the routes and the tests read
// the same number, and so that changing one is a visible diff rather than a
// search for the literal 5.

import * as v from 'valibot';
import type { Brand } from '../common/ids.ts';

export const literalUnion = <const T extends readonly [string, ...string[]]>(values: T) =>
  v.picklist(values);

export const JobIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
export type JobId = v.InferOutput<typeof JobIdSchema> & Brand<string, 'JobId'>;

export const AttemptIdSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
export type AttemptId = v.InferOutput<typeof AttemptIdSchema> & Brand<string, 'AttemptId'>;

/**
 * The only synthetic fixture this template will encode.
 *
 * Frozen with PR G's processor: `sample-v1` is the identity of a 3-second,
 * 320x180 clip generated locally by `starter-media fixture`. It is not a URL and
 * not a path — it names a fixture the deployment already holds in private R2.
 */
export const JOB_FIXTURE_IDS = ['sample-v1'] as const;
export const JobFixtureSchema = literalUnion(JOB_FIXTURE_IDS);
export type JobFixture = v.InferOutput<typeof JobFixtureSchema>;

/**
 * The only encode configuration this template will run.
 *
 * `demo-180p-v1` is a *name*, and the processor is the only thing that knows what
 * it expands to. That is the whole point: an FFmpeg argument vector is derived
 * from a preset inside the container, so no caller can influence the process it
 * starts.
 */
export const JOB_PRESET_IDS = ['demo-180p-v1'] as const;
export const JobPresetSchema = literalUnion(JOB_PRESET_IDS);
export type JobPreset = v.InferOutput<typeof JobPresetSchema>;

/** `JobKind` is a union of one today and grows with a versioned migration. */
export const JOB_KINDS = ['encode'] as const;
export const JobKindSchema = literalUnion(JOB_KINDS);
export type JobKind = v.InferOutput<typeof JobKindSchema>;

/**
 * The four states a job is in. There is no "expired" state.
 *
 * Artifact retention is 24 hours and it is reported as `outputAvailable: false`
 * on a job that still says `succeeded`. Inventing a fifth state would make the
 * terminal outcome of the *encode* depend on a later clock, and a caller could
 * no longer tell whether the encode failed or the artifact aged out.
 */
export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const;
export const JobStatusSchema = literalUnion(JOB_STATUSES);
export type JobStatus = v.InferOutput<typeof JobStatusSchema>;

/** Terminal states. A job in one of these is never written by an attempt again. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed'];

/** How far a dispatch attempt got. `pending` is the recoverable one. */
export const JOB_DISPATCH_STATES = ['pending', 'dispatched', 'dispatch_failed'] as const;
export const JobDispatchStateSchema = literalUnion(JOB_DISPATCH_STATES);
export type JobDispatchState = v.InferOutput<typeof JobDispatchStateSchema>;

// -----------------------------------------------------------------------------
// Admission bounds
//
// Each number is the demo's documented default. They live here because the
// repository enforces them, the routes report them, and the tests assert them —
// three consumers, one definition.
// -----------------------------------------------------------------------------

/** At most one job per user may be `pending` or `running` at a time. */
export const MAX_ACTIVE_JOBS_PER_USER = 1;

/** New jobs one user may create in any rolling hour. */
export const MAX_JOBS_PER_USER_HOUR = 5;

/** New manual jobs one environment may create in one UTC day. */
export const MAX_JOBS_PER_ENVIRONMENT_UTC_DAY = 50;

/** How long an encoded artifact stays downloadable. */
export const JOB_OUTPUT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Transient failures get at most this many retries, so a job runs at most three
 * attempts in total. Mirrors PR G's container, which refuses concurrent work.
 */
export const MAX_JOB_ATTEMPTS = 3;

/** How long one attempt may hold the job's lease before another may take it. */
export const JOB_ATTEMPT_LEASE_MS = 5 * 60 * 1000;

/** Ceiling on one list page. A bound, not a promise of scale. */
export const MAX_LISTED_JOBS = 50;

/** Shortest accepted `Idempotency-Key`. */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 1;

/**
 * Longest accepted `Idempotency-Key`.
 *
 * The key is stored in a column behind a unique index, so its length is a
 * storage bound as much as a protocol one. 100 printable ASCII characters is
 * generous for a client-generated UUID and short enough to keep that index small.
 */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 100;

/**
 * Accepted `Idempotency-Key` shape.
 *
 * Printable ASCII without spaces. A key containing arbitrary bytes would have to
 * be escaped into a header, an index key and a JSON error message, and each of
 * those is a place a control character ends up in a log line.
 */
export const IDEMPOTENCY_KEY_PATTERN = '^[\\x21-\\x7e]+$';

export const IdempotencyKeySchema = v.pipe(
  v.string(),
  v.minLength(IDEMPOTENCY_KEY_MIN_LENGTH),
  v.maxLength(IDEMPOTENCY_KEY_MAX_LENGTH),
  v.regex(new RegExp(IDEMPOTENCY_KEY_PATTERN)),
);

export type IdempotencyKey = v.InferOutput<typeof IdempotencyKeySchema>;

/** Header carrying the idempotency key. Frozen with the public contract. */
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Header the Worker binds when dispatching, so H reads one name. */
export const WORKFLOW_ID_PREFIX = 'encode-';

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

/**
 * The one body this API accepts.
 *
 * Two fields, both frozen enums. There is no `ownerId`, no `url`, no `codec`,
 * no `args` and no `preset` outside the union — which is why this schema is safe
 * to hand to a client for optimistic validation: every value it can hold is a
 * value this server will accept.
 */
export const CreateEncodeJobSchema = v.strictObject({
  fixture: JobFixtureSchema,
  preset: JobPresetSchema,
});

export type CreateEncodeJob = v.InferOutput<typeof CreateEncodeJobSchema>;

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

/**
 * What the processor reported about the bytes it produced.
 *
 * Separately versioned from `JobDto` on purpose: this shape is a statement about
 * an artifact and changes when the processor's probe changes. Folding it into
 * `JobDto` would make every consumer of the job list depend on the encoder's
 * measurement fields.
 *
 * A hash is integrity, not identity: it is a claim that these are the bytes that
 * were stored, not that two hosts produce bit-identical FFmpeg output.
 */
export const JobOutputSchema = v.strictObject({
  bytes: v.pipe(v.number(), v.integer(), v.finite(), v.minValue(1), v.maxValue(10 * 1024 * 1024)),
  sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  containerFormat: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  videoCodec: v.pipe(v.string(), v.minLength(1), v.maxLength(32)),
  width: v.pipe(v.number(), v.integer(), v.finite(), v.minValue(1), v.maxValue(8192)),
  height: v.pipe(v.number(), v.integer(), v.finite(), v.minValue(1), v.maxValue(8192)),
  durationMs: v.pipe(
    v.number(),
    v.integer(),
    v.finite(),
    v.minValue(1),
    v.maxValue(120 * 60 * 1000),
  ),
  /** Epoch ms at which retention removes the bytes. */
  expiresAt: v.pipe(v.number(), v.finite()),
});

export type JobOutput = v.InferOutput<typeof JobOutputSchema>;

/**
 * Codes a *job* can fail with, as written by this repository.
 *
 * A closed union, not `v.string()`. The alternative is a field that accepts
 * whatever a container, a subprocess or an exception put in it, and the comment
 * next to it would then be a lie: an error string that reaches a browser has to be
 * one this repository enumerated, and an open string cannot be.
 *
 * These are the job's own outcomes. The runner maps processor failures onto
 * these codes rather than passing process output through to the caller.
 */
export const JOB_ERROR_CODES = ['encode_failed', 'attempts_exhausted', 'internal_error'] as const;
export const JobErrorCodeSchema = literalUnion(JOB_ERROR_CODES);
export type JobErrorCode = v.InferOutput<typeof JobErrorCodeSchema>;

/**
 * A job as the API returns it.
 *
 * What is deliberately absent is the point of this file: no owner id, no private
 * storage key, no FFmpeg stderr, no attempt ids, no dispatch diagnostics. A
 * caller learns that a job exists, what state it is in, and — once the encode
 * succeeded — enough measured metadata to play the artifact.
 */
export const JobDtoSchema = v.strictObject({
  id: JobIdSchema,
  kind: JobKindSchema,
  status: JobStatusSchema,
  /** Epoch milliseconds. */
  createdAt: v.pipe(v.number(), v.finite()),
  updatedAt: v.pipe(v.number(), v.finite()),
  /** False for a job that has not produced bytes, or whose bytes aged out. */
  outputAvailable: v.boolean(),
  /**
   * A frozen code from `JOB_ERROR_CODES`, or null. Never prose and never a
   * subprocess message.
   */
  errorCode: v.union([JobErrorCodeSchema, v.null()]),
});

export type JobDto = v.InferOutput<typeof JobDtoSchema>;

/** One page of a user's jobs. */
export const JobListSchema = v.strictObject({
  jobs: v.array(JobDtoSchema),
  /** Opaque. Null on the last page. */
  nextCursor: v.union([v.pipe(v.string(), v.minLength(1)), v.null()]),
  serverTime: v.pipe(v.number(), v.finite()),
});

export type JobList = v.InferOutput<typeof JobListSchema>;

/**
 * Codes a create request can be refused with.
 *
 * The API's own admission outcomes, separate from worker process failures.
 */
export const JobAdmissionErrorCode = {
  /** The body is not one of the frozen shapes. 400. */
  invalidRequest: 'invalid_request',
  /** The `Idempotency-Key` header is absent or malformed. 400. */
  invalidIdempotencyKey: 'invalid_idempotency_key',
  /** No session. 401. */
  unauthenticated: 'unauthenticated',
  /** Session exists, address not confirmed. 403. */
  emailNotVerified: 'email_not_verified',
  /** Same key, different body. 409. */
  idempotencyConflict: 'idempotency_conflict',
  /** Active, hourly or daily budget exhausted. 429. */
  budgetExceeded: 'budget_exceeded',
  /** The jobs profile is not enabled for this deployment. 503. */
  profileUnavailable: 'jobs_profile_disabled',
} as const;

export type JobAdmissionErrorCodeValue =
  (typeof JobAdmissionErrorCode)[keyof typeof JobAdmissionErrorCode];

/**
 * Re-exported so a caller can type a validated value without importing Valibot.
 *
 * `TSchema` rather than a specific union: this is the parameter type of
 * `checkSchema`, and nothing here claims more precision than the validator uses.
 */
export type JobSchema = v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>;

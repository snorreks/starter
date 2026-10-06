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

import { type Static, type TLiteral, type TSchema, type TUnion, Type } from 'typebox';
import type { Brand } from '../common/ids.ts';

/**
 * One `TLiteral` per value, in the same order, as a mutable tuple.
 *
 * `-readonly` because `T` is a `readonly` tuple (`as const`) while `TUnion`
 * takes a mutable one.
 */
type LiteralTuple<T extends readonly string[]> = {
  -readonly [K in keyof T]: TLiteral<T[K] & string>;
};

/**
 * A closed union of the given literal strings.
 *
 * Written as a helper rather than inline `Type.Union([...])` so that every
 * enumerated set in this file has the same shape and the compiler keeps the
 * literal types: `Static` of the result is `'a' | 'b'`, never `string`. A union
 * that widened to `string` would accept any value, which is exactly what the
 * closed schemas below exist to prevent.
 *
 * TypeBox 1.x resolves `Static` of a union by walking its members as a
 * *tuple*, accumulating a union as it goes. An unbounded array type — what
 * `Array.prototype.map` returns — is not a tuple, so the walk stops
 * immediately and `Static` comes out `never`, which then rejects every value
 * that is one of the literals. `LiteralTuple` exists for that walk.
 */
export const literalUnion = <const T extends readonly string[]>(
  values: T,
): TUnion<LiteralTuple<T>> => {
  // Two details, and both are about the tuple above. `map` always returns an
  // array, so the tuple is asserted rather than inferred; and `Type.Union`
  // infers an array from a bare tuple argument, so the tuple is spread to
  // survive. Nothing past this line is asserted: `TERMINAL_JOB_STATUSES`
  // further down only typechecks because `JobStatus` resolved to the four
  // literals rather than to `never`.
  const schemas = values.map((value) => Type.Literal(value)) as LiteralTuple<T>;
  return Type.Union([...schemas]);
};

export const JobIdSchema = Type.String({ minLength: 1, maxLength: 64 });
export type JobId = Static<typeof JobIdSchema> & Brand<string, 'JobId'>;

export const AttemptIdSchema = Type.String({ minLength: 1, maxLength: 128 });
export type AttemptId = Static<typeof AttemptIdSchema> & Brand<string, 'AttemptId'>;

/**
 * The only synthetic fixture this template will encode.
 *
 * Frozen with PR G's processor: `sample-v1` is the identity of a 3-second,
 * 320x180 clip generated locally by `starter-media fixture`. It is not a URL and
 * not a path — it names a fixture the deployment already holds in private R2.
 */
export const JOB_FIXTURE_IDS = ['sample-v1'] as const;
export const JobFixtureSchema = literalUnion(JOB_FIXTURE_IDS);
export type JobFixture = Static<typeof JobFixtureSchema>;

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
export type JobPreset = Static<typeof JobPresetSchema>;

/** `JobKind` is a union of one today and grows with a versioned migration. */
export const JOB_KINDS = ['encode'] as const;
export const JobKindSchema = literalUnion(JOB_KINDS);
export type JobKind = Static<typeof JobKindSchema>;

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
export type JobStatus = Static<typeof JobStatusSchema>;

/** Terminal states. A job in one of these is never written by an attempt again. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed'];

/** How far a dispatch attempt got. `pending` is the recoverable one. */
export const JOB_DISPATCH_STATES = ['pending', 'dispatched', 'dispatch_failed'] as const;
export const JobDispatchStateSchema = literalUnion(JOB_DISPATCH_STATES);
export type JobDispatchState = Static<typeof JobDispatchStateSchema>;

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

export const IdempotencyKeySchema = Type.String({
  minLength: IDEMPOTENCY_KEY_MIN_LENGTH,
  maxLength: IDEMPOTENCY_KEY_MAX_LENGTH,
  pattern: IDEMPOTENCY_KEY_PATTERN,
});

export type IdempotencyKey = Static<typeof IdempotencyKeySchema>;

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
export const CreateEncodeJobSchema = Type.Object(
  {
    fixture: JobFixtureSchema,
    preset: JobPresetSchema,
  },
  { additionalProperties: false },
);

export type CreateEncodeJob = Static<typeof CreateEncodeJobSchema>;

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
export const JobOutputSchema = Type.Object(
  {
    bytes: Type.Integer({ minimum: 1, maximum: 10 * 1024 * 1024 }),
    sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    containerFormat: Type.String({ minLength: 1, maxLength: 64 }),
    videoCodec: Type.String({ minLength: 1, maxLength: 32 }),
    width: Type.Integer({ minimum: 1, maximum: 8192 }),
    height: Type.Integer({ minimum: 1, maximum: 8192 }),
    durationMs: Type.Integer({ minimum: 1, maximum: 120 * 60 * 1000 }),
    /** Epoch ms at which retention removes the bytes. */
    expiresAt: Type.Number(),
  },
  { additionalProperties: false },
);

export type JobOutput = Static<typeof JobOutputSchema>;

/**
 * Codes a *job* can fail with, as written by this repository.
 *
 * A closed union, not `Type.String()`. The alternative is a field that accepts
 * whatever a container, a subprocess or an exception put in it, and the comment
 * next to it would then be a lie: an error string that reaches a browser has to be
 * one this repository enumerated, and an open string cannot be.
 *
 * These are the job's own outcomes. The processor's refusal codes
 * (`invalid_media`, `deadline_exceeded`, …) are a different, larger set and live
 * in `./processor_protocol.ts`; the repository maps one of those onto one of
 * these rather than passing it through.
 */
export const JOB_ERROR_CODES = ['encode_failed', 'attempts_exhausted', 'internal_error'] as const;
export const JobErrorCodeSchema = literalUnion(JOB_ERROR_CODES);
export type JobErrorCode = Static<typeof JobErrorCodeSchema>;

/**
 * A job as the API returns it.
 *
 * What is deliberately absent is the point of this file: no owner id, no private
 * storage key, no FFmpeg stderr, no attempt ids, no dispatch diagnostics. A
 * caller learns that a job exists, what state it is in, and — once the encode
 * succeeded — enough measured metadata to play the artifact.
 */
export const JobDtoSchema = Type.Object(
  {
    id: JobIdSchema,
    kind: JobKindSchema,
    status: JobStatusSchema,
    /** Epoch milliseconds. */
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
    /** False for a job that has not produced bytes, or whose bytes aged out. */
    outputAvailable: Type.Boolean(),
    /**
     * A frozen code from `JOB_ERROR_CODES`, or null. Never prose and never a
     * subprocess message.
     */
    errorCode: Type.Union([JobErrorCodeSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

export type JobDto = Static<typeof JobDtoSchema>;

/** One page of a user's jobs. */
export const JobListSchema = Type.Object(
  {
    jobs: Type.Array(JobDtoSchema),
    /** Opaque. Null on the last page. */
    nextCursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    serverTime: Type.Number(),
  },
  { additionalProperties: false },
);

export type JobList = Static<typeof JobListSchema>;

/**
 * Codes a create request can be refused with.
 *
 * The API's own admission outcomes. The processor's error codes are a separate,
 * larger set — see `./processor_protocol.ts` — because "the container said the
 * media was invalid" and "you have used your five jobs" are facts about different
 * subjects.
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
 * Re-exported so a caller can type a validated value without importing TypeBox.
 *
 * `TSchema` rather than a specific union: this is the parameter type of
 * `Value.Check`, and nothing here claims more precision than the validator uses.
 */
export type { TSchema as JobSchema };

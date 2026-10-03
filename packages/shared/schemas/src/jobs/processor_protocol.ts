// packages/shared/schemas/src/jobs/processor_protocol.ts
//
// The wire contract with the Rust processor in `apps/backend/media`.
//
// Ownership: PR G froze the Rust side and shipped golden files under
// `apps/backend/media/fixtures/protocol/`. This file types that wire from the
// other end. `processor_protocol.test.ts` reads *those files* — not copies of
// them — so a rename in Rust fails a TypeScript test here and a drift in a
// hand-copied fixture cannot.
//
// Both directions are covered, for the same reason the Rust golden test checks
// both: a document one side can produce and the other cannot parse is a document
// that documents a bug.
//
// `additionalProperties: false` on every document. The Rust structs are
// `serde` structs without `deny_unknown_fields` in one direction and with it in
// the other, so a field added on one side without the other is a mismatch this
// schema refuses to paper over.

import { type Static, Type } from '@sinclair/typebox';
import { literalUnion } from './job.ts';

/**
 * Wire protocol version. Must equal `PROTOCOL_ID` in
 * `apps/backend/media/src/protocol.rs`; asserted by the fixture test rather
 * than trusted, because a comment cannot fail a build.
 */
export const PROCESSOR_PROTOCOL_ID = 'sample-v1';

/** The only preset the processor accepts. Must equal its `PRESET_ID`. */
export const PROCESSOR_PRESET_ID = 'demo-180p-v1';

/** The only fixture identity the processor accepts. */
export const PROCESSOR_FIXTURE_ID = 'sample-v1';

/** Request header naming the protocol. Absent means `PROCESSOR_PROTOCOL_ID`. */
export const PROCESSOR_HEADER_PROTOCOL = 'x-protocol';
/** Request header naming the preset. Required. */
export const PROCESSOR_HEADER_PRESET = 'x-preset';
/** Request header naming the attempt. Required; echoed in the response. */
export const PROCESSOR_HEADER_ATTEMPT = 'x-attempt-id';

/** Every bound the processor enforces, as its `/health` reports it. */
export const ProcessorLimitsSchema = Type.Object(
  {
    max_input_bytes: Type.Integer({ minimum: 1 }),
    max_output_bytes: Type.Integer({ minimum: 1 }),
    encode_deadline_ms: Type.Integer({ minimum: 1 }),
    probe_deadline_ms: Type.Integer({ minimum: 1 }),
    max_encode_threads: Type.Integer({ minimum: 1 }),
    max_concurrent_encodes: Type.Integer({ minimum: 1 }),
    max_attempt_id_len: Type.Integer({ minimum: 1 }),
    stderr_keep_bytes: Type.Integer({ minimum: 1 }),
  },
  { additionalProperties: false },
);

export type ProcessorLimits = Static<typeof ProcessorLimitsSchema>;

/** One accepted preset, described well enough for a caller to display it. */
export const ProcessorPresetSummarySchema = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    fps: Type.Integer({ minimum: 1 }),
    video_codec: Type.String({ minLength: 1 }),
    /** `null` for a preset with no audio stream. */
    audio_codec: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
    container: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

export type ProcessorPresetSummary = Static<typeof ProcessorPresetSummarySchema>;

/** What the processor can do, from its `GET /health`. */
export const ProcessorHealthSchema = Type.Object(
  {
    release: Type.String({ minLength: 1 }),
    protocol: Type.String({ minLength: 1 }),
    presets: Type.Array(ProcessorPresetSummarySchema, { minItems: 1 }),
    fixture: Type.String({ minLength: 1 }),
    limits: ProcessorLimitsSchema,
  },
  { additionalProperties: false },
);

export type ProcessorHealth = Static<typeof ProcessorHealthSchema>;

/** What ffprobe actually measured about the produced file. */
export const ProcessorProbeSummarySchema = Type.Object(
  {
    container_format: Type.String({ minLength: 1 }),
    video_codec: Type.String({ minLength: 1 }),
    width: Type.Integer({ minimum: 1 }),
    height: Type.Integer({ minimum: 1 }),
    duration_ms: Type.Integer({ minimum: 1 }),
    video_streams: Type.Integer({ minimum: 1 }),
    audio_streams: Type.Integer({ minimum: 0 }),
  },
  { additionalProperties: false },
);

export type ProcessorProbeSummary = Static<typeof ProcessorProbeSummarySchema>;

/** The metadata a successful `/encode` reports about the bytes it produced. */
export const ProcessorEncodeSuccessSchema = Type.Object(
  {
    protocol: Type.String({ minLength: 1 }),
    preset: Type.String({ minLength: 1 }),
    attempt_id: Type.String({ minLength: 1 }),
    output_bytes: Type.Integer({ minimum: 1 }),
    output_sha256: Type.String({ pattern: '^[0-9a-f]{64}$' }),
    probe: ProcessorProbeSummarySchema,
  },
  { additionalProperties: false },
);

export type ProcessorEncodeSuccess = Static<typeof ProcessorEncodeSuccessSchema>;

/**
 * The processor's frozen error tokens.
 *
 * Enumerated rather than `Type.String()` because a caller branching on them
 * needs the *union*, and because the retry decision depends on it: only the
 * codes marked retryable may be retried, and everything else is terminal.
 */
export const PROCESSOR_ERROR_CODES = [
  'input_empty',
  'payload_too_large',
  'unsupported_transfer_encoding',
  'protocol_mismatch',
  'unsupported_preset',
  'invalid_attempt_id',
  'busy',
  'invalid_media',
  'output_too_large',
  'invalid_output',
  'deadline_exceeded',
  'cancelled',
  'not_found',
  'internal_error',
] as const;

export const ProcessorErrorCodeSchema = literalUnion(PROCESSOR_ERROR_CODES);

export type ProcessorErrorCode = Static<typeof ProcessorErrorCodeSchema>;

/**
 * The subset worth retrying with the same bytes.
 *
 * `busy` is here because the container accepts one encode at a time and says so
 * rather than queueing; `deadline_exceeded` is here because a slower host is a
 * legitimate retry. Everything else describes the *input* or the *request*, and
 * retrying those identical bytes produces the identical refusal.
 */
export const RETRYABLE_PROCESSOR_ERROR_CODES: readonly ProcessorErrorCode[] = [
  'busy',
  'deadline_exceeded',
  'internal_error',
];

export const isRetryableProcessorError = (code: ProcessorErrorCode): boolean =>
  RETRYABLE_PROCESSOR_ERROR_CODES.includes(code);

/** The body of every non-2xx processor response. */
export const ProcessorErrorSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: ProcessorErrorCodeSchema,
        /** A fixed sentence. Never contains caller data, paths or stderr. */
        message: Type.String({ minLength: 1 }),
        retryable: Type.Boolean(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type ProcessorError = Static<typeof ProcessorErrorSchema>;

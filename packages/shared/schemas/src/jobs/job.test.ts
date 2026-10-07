// packages/shared/schemas/src/jobs/job.test.ts
//
// The refusals, which are the whole point.
//
// Every test here names the request that must be turned away and what an
// acceptance would cost. `strictObject` is what turns
// schema validation into a refusal mechanism, and a closed schema that quietly
// accepts-and-drops a field makes the client believe a write succeeded — which is
// how a request carrying somebody else's `ownerId` becomes an authorization
// question instead of a validation error.

import { describe, expect, test } from 'bun:test';
import { checkSchema } from '../validation.ts';
import {
  CreateEncodeJobSchema,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKeySchema,
  JOB_OUTPUT_RETENTION_MS,
  JobDtoSchema,
  JobListSchema,
  JobOutputSchema,
  MAX_ACTIVE_JOBS_PER_USER,
  MAX_JOBS_PER_ENVIRONMENT_UTC_DAY,
  MAX_JOBS_PER_USER_HOUR,
} from './job.ts';

const validRequest = () => ({ fixture: 'sample-v1', preset: 'demo-180p-v1' });

describe('CreateEncodeJobSchema', () => {
  test('accepts the one request this API can express', () => {
    expect(checkSchema(CreateEncodeJobSchema, validRequest())).toBe(true);
  });

  test('refuses a client that names its own owner', () => {
    // The exact attack this schema exists to stop: if `ownerId` were accepted and
    // ignored, the server would still create the job for the *session's* user and
    // the caller would believe it created one for somebody else. Accepting the
    // field would make that a supported request instead of a mistake.
    expect(
      checkSchema(CreateEncodeJobSchema, { ...validRequest(), ownerId: 'user_somebody_else' }),
    ).toBe(false);
  });

  test('refuses a URL for the input media', () => {
    // "Encode anything I point at" is the feature that turns a demo into an open
    // fetch-and-encode service pointed at somebody else's infrastructure.
    expect(
      checkSchema(CreateEncodeJobSchema, {
        fixture: 'https://example.invalid/v.mp4',
        preset: 'demo-180p-v1',
      }),
    ).toBe(false);
  });

  test('refuses an ffmpeg argument vector', () => {
    expect(checkSchema(CreateEncodeJobSchema, { ...validRequest(), args: ['-f', 'lavfi'] })).toBe(
      false,
    );
  });

  test('refuses a preset outside the frozen set', () => {
    expect(
      checkSchema(CreateEncodeJobSchema, { fixture: 'sample-v1', preset: 'uhd-2160p-v1' }),
    ).toBe(false);
  });

  test('refuses a missing field', () => {
    expect(checkSchema(CreateEncodeJobSchema, { fixture: 'sample-v1' })).toBe(false);
    expect(checkSchema(CreateEncodeJobSchema, { preset: 'demo-180p-v1' })).toBe(false);
  });
});

describe('IdempotencyKeySchema', () => {
  test('accepts a client-generated UUID', () => {
    expect(checkSchema(IdempotencyKeySchema, 'b8f1c0de-2f2b-4a2e-9a5a-7f6a1b2c3d4e')).toBe(true);
  });

  test('refuses an empty key', () => {
    // An empty key would collapse every request from one user onto one row, and
    // the second request would answer with the first job instead of creating one.
    expect(checkSchema(IdempotencyKeySchema, '')).toBe(false);
  });

  test('refuses a key with whitespace', () => {
    // Headers cannot carry a raw newline, and a space is not trimmed identically
    // by every hop; a key that differs by invisible characters is a key that
    // defeats idempotency without the caller noticing.
    expect(checkSchema(IdempotencyKeySchema, 'abc def')).toBe(false);
  });

  test('refuses a key longer than the bound', () => {
    expect(checkSchema(IdempotencyKeySchema, 'k'.repeat(101))).toBe(false);
    expect(checkSchema(IdempotencyKeySchema, 'k'.repeat(100))).toBe(true);
  });

  test('is read from the frozen header name', () => {
    expect(IDEMPOTENCY_KEY_HEADER).toBe('idempotency-key');
  });
});

describe('JobDtoSchema', () => {
  const validDto = () => ({
    id: 'job_1',
    kind: 'encode',
    status: 'pending',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    outputAvailable: false,
    errorCode: null,
  });

  test('accepts a pending job', () => {
    expect(checkSchema(JobDtoSchema, validDto())).toBe(true);
  });

  test('accepts each of the four states', () => {
    for (const status of ['pending', 'running', 'succeeded', 'failed']) {
      expect(checkSchema(JobDtoSchema, { ...validDto(), status })).toBe(true);
    }
  });

  test('refuses a fifth state', () => {
    // There is no `expired`. Retention is reported through `outputAvailable`, so
    // a caller can always tell an aged-out artifact from a failed encode.
    expect(checkSchema(JobDtoSchema, { ...validDto(), status: 'expired' })).toBe(false);
  });

  test('refuses to carry an owner id back to a client', () => {
    // Echoing `ownerId` is harmless on its own; including it is what makes the DTO
    // the place a second, unchecked copy of the ownership rule can grow.
    expect(checkSchema(JobDtoSchema, { ...validDto(), ownerId: 'user_1' })).toBe(false);
  });

  test('refuses to carry the private storage key', () => {
    expect(checkSchema(JobDtoSchema, { ...validDto(), outputKey: 'jobs/j1/out.mp4' })).toBe(false);
  });

  test('refuses raw subprocess output in the error field', () => {
    // The error field is a closed union of the codes this repository enumerates.
    // A message would be the one place a container's stderr could reach a browser.
    expect(
      checkSchema(JobDtoSchema, {
        ...validDto(),
        status: 'failed',
        errorCode: 'ffmpeg exited 1: Invalid data found',
      }),
    ).toBe(false);
    // And a processor code is not a job code: the repository maps one onto the
    // other, so a processor token never reaches a client verbatim.
    expect(
      checkSchema(JobDtoSchema, { ...validDto(), status: 'failed', errorCode: 'invalid_media' }),
    ).toBe(false);
  });

  test('a succeeded job with an expired artifact still says succeeded', () => {
    const aged = { ...validDto(), status: 'succeeded', outputAvailable: false };
    expect(checkSchema(JobDtoSchema, aged)).toBe(true);
  });
});

describe('JobOutputSchema', () => {
  const validOutput = () => ({
    bytes: 4096,
    sha256: 'a'.repeat(64),
    containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
    videoCodec: 'h264',
    width: 320,
    height: 180,
    durationMs: 3000,
    expiresAt: 1_700_000_000_000 + JOB_OUTPUT_RETENTION_MS,
  });

  test('accepts measured metadata', () => {
    expect(checkSchema(JobOutputSchema, validOutput())).toBe(true);
  });

  test('refuses a non-lowercase hash', () => {
    expect(checkSchema(JobOutputSchema, { ...validOutput(), sha256: 'A'.repeat(64) })).toBe(false);
  });

  test('refuses output above the processor ceiling', () => {
    // 10 MiB is the processor's own `max_output_bytes`; a DTO that allowed more
    // would let a caller expect bytes the container cannot produce.
    expect(checkSchema(JobOutputSchema, { ...validOutput(), bytes: 10 * 1024 * 1024 + 1 })).toBe(
      false,
    );
  });

  test('refuses a zero-byte artifact', () => {
    expect(checkSchema(JobOutputSchema, { ...validOutput(), bytes: 0 })).toBe(false);
  });
});

describe('JobListSchema', () => {
  const job = () => ({
    id: 'job_1',
    kind: 'encode',
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
    outputAvailable: false,
    errorCode: null,
  });

  test('accepts a page with and without a cursor', () => {
    expect(checkSchema(JobListSchema, { jobs: [job()], nextCursor: 'job_0', serverTime: 1 })).toBe(
      true,
    );
    expect(checkSchema(JobListSchema, { jobs: [], nextCursor: null, serverTime: 1 })).toBe(true);
  });

  test('refuses an undefined cursor', () => {
    // `undefined` disappears through `JSON.stringify`, so a client would read it as
    // "no next page" while the server meant "malformed".
    expect(checkSchema(JobListSchema, { jobs: [], serverTime: 1 })).toBe(false);
  });
});

describe('the frozen admission bounds', () => {
  test('match the documented demo policy', () => {
    // Asserted rather than referenced: a bound changed in one file and read from
    // another is a policy nobody agreed to.
    expect(MAX_ACTIVE_JOBS_PER_USER).toBe(1);
    expect(MAX_JOBS_PER_USER_HOUR).toBe(5);
    expect(MAX_JOBS_PER_ENVIRONMENT_UTC_DAY).toBe(50);
    expect(JOB_OUTPUT_RETENTION_MS).toBe(86_400_000);
  });
});

// packages/shared/schemas/src/jobs/processor_protocol.test.ts
//
// The TypeScript end of the Rust wire contract.
//
// The fixtures under test are *PR G's committed golden files*, read from
// `apps/backend/media/fixtures/protocol/`. They are deliberately not copied into
// this package: a copy is a second document that can agree with the first for a
// release and disagree with it for ever after, and the disagreement is invisible
// until a container returns a field nobody expects.
//
// Two directions are checked:
//
//   * every committed golden parses against the schema here, with no unknown
//     field — a Rust field this file does not know about fails;
//   * a document this package builds validates — so the schema is not merely a
//     filter that rejects everything.
//
// The Rust suite checks the mirror image from its side. Between them, a rename
// in either crate is a red test in both repositories, not a runtime surprise.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSchema } from '../validation.ts';
import {
  isRetryableProcessorError,
  PROCESSOR_FIXTURE_ID,
  PROCESSOR_PRESET_ID,
  PROCESSOR_PROTOCOL_ID,
  ProcessorEncodeSuccessSchema,
  ProcessorErrorSchema,
  ProcessorHealthSchema,
} from './processor_protocol.ts';

/**
 * Where PR G's golden files live.
 *
 * Derived from this file's own URL rather than from `process.cwd()`: the unit lane
 * runs from the package directory and the Worker lane from the repository root,
 * and a path built from the working directory names a directory that exists in
 * one lane and not the other. Four levels up from `src/jobs/` is the repository
 * root.
 */
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url)).replace(/\/$/, '');
const GOLDEN_DIR = join(REPO_ROOT, 'apps/backend/media/fixtures/protocol');

const golden = (name: string): unknown => {
  const path = join(GOLDEN_DIR, name);
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // A missing or unparseable golden is a test failure, never a skip: the whole
    // claim of this file is that the two sides agree, and "no fixture to check"
    // is agreement proved by nothing.
    throw new Error(`Could not read the committed protocol golden ${path}: ${String(error)}`);
  }
};

describe('the Rust processor golden fixtures', () => {
  test('health.v1.json matches ProcessorHealthSchema', () => {
    const document = golden('health.v1.json');
    expect(checkSchema(ProcessorHealthSchema, document)).toBe(true);
  });

  test('health.v1.json names the frozen protocol, preset and fixture', () => {
    // The constants in this package are the claim; the golden is the evidence.
    // Reading them out of the fixture rather than asserting them here means a
    // change on the Rust side has to be carried across deliberately.
    const health = golden('health.v1.json') as {
      protocol: string;
      fixture: string;
      presets: Array<{ id: string }>;
    };
    expect(health.protocol).toBe(PROCESSOR_PROTOCOL_ID);
    expect(health.fixture).toBe(PROCESSOR_FIXTURE_ID);
    expect(health.presets.map((preset) => preset.id)).toEqual([PROCESSOR_PRESET_ID]);
  });

  test('encode-success.v1.json matches ProcessorEncodeSuccessSchema', () => {
    expect(checkSchema(ProcessorEncodeSuccessSchema, golden('encode-success.v1.json'))).toBe(true);
  });

  for (const name of [
    'error-invalid-media.v1.json',
    'error-payload-too-large.v1.json',
    'error-busy.v1.json',
    'error-unsupported-preset.v1.json',
  ]) {
    test(`${name} matches ProcessorErrorSchema`, () => {
      expect(checkSchema(ProcessorErrorSchema, golden(name))).toBe(true);
    });
  }

  test('every error golden carries a code this package can branch on', () => {
    // A bare string schema would accept anything and defeat the retry
    // decision, which is the only reason these codes are enumerated.
    for (const name of [
      'error-invalid-media.v1.json',
      'error-payload-too-large.v1.json',
      'error-busy.v1.json',
      'error-unsupported-preset.v1.json',
    ]) {
      const document = golden(name) as { error: { code: string; retryable: boolean } };
      expect(isRetryableProcessorError(document.error.code as never)).toBe(
        document.error.retryable,
      );
    }
  });
});

describe('ProcessorEncodeSuccessSchema', () => {
  const success = () => ({
    protocol: PROCESSOR_PROTOCOL_ID,
    preset: PROCESSOR_PRESET_ID,
    attempt_id: 'attempt-1',
    output_bytes: 12345,
    output_sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    probe: {
      container_format: 'mov,mp4,m4a,3gp,3g2,mj2',
      video_codec: 'h264',
      width: 320,
      height: 180,
      duration_ms: 3000,
      video_streams: 1,
      audio_streams: 1,
    },
  });

  test('accepts a document this package builds', () => {
    expect(checkSchema(ProcessorEncodeSuccessSchema, success())).toBe(true);
  });

  test('refuses a field the Rust struct does not carry', () => {
    // The direction that catches a TypeScript-side addition: an extra field is
    // never silently accepted, because the Rust reader would drop it.
    expect(
      checkSchema(ProcessorEncodeSuccessSchema, { ...success(), container: '/tmp/out.mp4' }),
    ).toBe(false);
  });

  test('refuses an uppercase hash', () => {
    // The Rust side emits lowercase hex; a client that compares case-sensitively
    // against an uppercase value would report a mismatch that is not one.
    expect(
      checkSchema(ProcessorEncodeSuccessSchema, {
        ...success(),
        output_sha256: success().output_sha256.toUpperCase(),
      }),
    ).toBe(false);
  });

  test('refuses a zero-length output', () => {
    expect(checkSchema(ProcessorEncodeSuccessSchema, { ...success(), output_bytes: 0 })).toBe(
      false,
    );
  });
});

describe('ProcessorErrorSchema', () => {
  test('accepts a terminal error', () => {
    expect(
      checkSchema(ProcessorErrorSchema, {
        error: {
          code: 'invalid_media',
          message: 'input media could not be decoded',
          retryable: false,
        },
      }),
    ).toBe(true);
  });

  test('refuses a code this package does not know', () => {
    expect(
      checkSchema(ProcessorErrorSchema, {
        error: { code: 'ffmpeg_exploded', message: '…', retryable: false },
      }),
    ).toBe(false);
  });

  test('only transient transport codes are retryable', () => {
    expect(isRetryableProcessorError('busy')).toBe(true);
    expect(isRetryableProcessorError('deadline_exceeded')).toBe(true);
    // Retrying identical bytes that the processor already called invalid produces
    // the identical refusal, three times, and then a failed job.
    expect(isRetryableProcessorError('invalid_media')).toBe(false);
    expect(isRetryableProcessorError('unsupported_preset')).toBe(false);
    expect(isRetryableProcessorError('protocol_mismatch')).toBe(false);
  });
});

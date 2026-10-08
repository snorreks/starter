import { describe, expect, test } from 'bun:test';
import { assertCaptureSha256 } from './capture_manifest.ts';

describe('visual capture manifest digests', () => {
  test('requires a valid producer digest before capture can claim verification', () => {
    expect(() => assertCaptureSha256(undefined, 'a'.repeat(64), 'captures/home.png')).toThrow(
      'valid SHA-256',
    );
    expect(() => assertCaptureSha256('not-a-digest', 'a'.repeat(64), 'captures/home.png')).toThrow(
      'valid SHA-256',
    );
  });

  test('requires the producer digest to match the screenshot bytes', () => {
    expect(() => assertCaptureSha256('b'.repeat(64), 'a'.repeat(64), 'captures/home.png')).toThrow(
      'Capture hash mismatch',
    );
  });

  test('accepts the exact lowercase SHA-256 digest', () => {
    expect(() =>
      assertCaptureSha256('a'.repeat(64), 'a'.repeat(64), 'captures/home.png'),
    ).not.toThrow();
  });
});

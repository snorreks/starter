// apps/backend/jobs/src/sha256.test.ts
//
// The streaming hash, checked against the platform's own digest.
//
// The vectors are chosen where a broken implementation differs from a working
// one: an empty message, a message shorter than one block, a message that exactly
// fills a block (so the padding needs a second block), and messages that straddle
// the boundary. Each is also fed in awkward chunk sizes, because the caller is a
// network stream and knows nothing about block boundaries.

import { describe, expect, test } from 'bun:test';
import { Sha256, sha256Hex } from './sha256.ts';

const reference = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
};

const pattern = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 31 + 7) & 0xff;
  }
  return bytes;
};

const feedInChunks = (bytes: Uint8Array, size: number): string => {
  const hash = new Sha256();
  for (let offset = 0; offset < bytes.length; offset += size) {
    hash.update(bytes.subarray(offset, offset + size));
  }
  return hash.hex();
};

describe('the streaming artifact hash', () => {
  const lengths = [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 4096, 112_717];

  test('agrees with the platform digest at every boundary', async () => {
    for (const length of lengths) {
      const bytes = pattern(length);
      expect(await sha256Hex(bytes)).toBe(await reference(bytes));
    }
  });

  test('does not depend on how the bytes were chunked', async () => {
    // The artifact path hashes whatever the socket delivered, so a hash that
    // depended on chunk boundaries would disagree with the processor's own hash
    // on some encodes and not others.
    for (const length of [64, 65, 200]) {
      const bytes = pattern(length);
      const expected = await reference(bytes);
      for (const size of [1, 7, 63, 64, 65, 1000]) {
        expect(feedInChunks(bytes, size)).toBe(expected);
      }
    }
  });

  test('reading the hex does not end the hash', () => {
    const hash = new Sha256();
    hash.update(pattern(10));
    const first = hash.hex();
    // Reading twice with nothing absorbed in between must give the same value,
    // or `hex()` would be a destructive operation and the artifact path could not
    // hash a stream in pieces.
    expect(hash.hex()).toBe(first);
    hash.update(pattern(10));
    // And absorbing more must change it.
    expect(hash.hex()).not.toBe(first);
  });

  test('differs for one flipped bit', () => {
    const a = pattern(64);
    const b = pattern(64);
    b[31] = (b[31] ?? 0) ^ 0x01;
    expect(sha256Hex(a)).not.toBe(sha256Hex(b));
  });
});

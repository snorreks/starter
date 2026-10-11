// apps/backend/live/src/protocol.test.ts
//
// The bytes on a live socket.
//
// This is the small module whose correctness decides whether the whole push path
// works, and it has one failure mode that matters above the others: the two ends
// disagreeing about where a frame's payload begins. Every case here is about that
// boundary, and one of them exists because an earlier encoding got it wrong.

import { describe, expect, test } from 'bun:test';
import {
  INVALIDATE,
  invalidateFrame,
  readInvalidateFrame,
  readSubscribeFrame,
  SUBSCRIBE,
  subscribeFrame,
  topicRefusal,
} from './protocol.ts';

describe('asking to watch a topic', () => {
  test('round-trips through the reader', () => {
    for (const topic of [
      'conversation:abc',
      'conversations',
      'a',
      'conversation:with-dashes',
      'conversation:7f1c2e0a-1111-2222-3333-444455556666',
    ]) {
      const frame = subscribeFrame(topic);
      expect(frame).not.toBeNull();
      expect(readSubscribeFrame(frame as string)).toBe(topic);
    }
  });

  test('carries a colon-bearing topic whole', () => {
    // This repository namespaces topics with a colon. An encoding that treated the
    // colon as a separator would either refuse every real topic, or truncate
    // `conversation:a:b` to `conversation:a` — which is itself a real topic, so
    // the subscription would be *accepted* and watching the wrong thing.
    expect(readSubscribeFrame(subscribeFrame('conversation:a:b') as string)).toBe(
      'conversation:a:b',
    );
  });

  test('refuses an empty topic rather than subscribing to nothing', () => {
    // A socket watching nothing is never told about anything, so it looks healthy
    // while being as stale as one that never connected.
    expect(subscribeFrame('')).toBeNull();
    expect(topicRefusal('')).toBe('empty');
    expect(readSubscribeFrame(SUBSCRIBE)).toBeNull();
  });

  test('is distinguishable from an invalidation', () => {
    // The two frames differ only in their leading byte. If the tags were ever
    // transposed, a client would read "your topic moved" as a subscription and
    // subscribe to a topic it never asked about.
    const sent = subscribeFrame('conversations') as string;
    expect(sent.startsWith(SUBSCRIBE)).toBe(true);
    expect(readInvalidateFrame(sent)).toBeNull();
  });

  test('a reader given something that is not a subscribe frame says so', () => {
    for (const raw of ['', 'x', '9topic', 'ping', 'null']) {
      expect(readSubscribeFrame(raw)).toBeNull();
    }
  });
});

describe('being told a topic moved', () => {
  test('round-trips', () => {
    const frame = invalidateFrame('conversation:abc');
    expect(readInvalidateFrame(new TextDecoder().decode(frame))).toBe('conversation:abc');
  });

  test('carries no payload beyond the topic', () => {
    // A notification that carried content would be a second copy of the data and a
    // second thing to authorize. The frame is exactly the tag and the topic — there
    // is nowhere in it for a payload to go.
    const text = new TextDecoder().decode(invalidateFrame('conversations'));
    expect(text).toBe(`${INVALIDATE}conversations`);
  });

  test('a reader given a close or a proxy payload says so rather than guessing', () => {
    // The case that matters: a socket that closed, or a proxy that injected a
    // message, must not be read as "your topic moved".
    for (const raw of ['', INVALIDATE, 'error', `${SUBSCRIBE}conversations`, 'ping', 'undefined']) {
      expect(readInvalidateFrame(raw)).toBeNull();
    }
  });
});

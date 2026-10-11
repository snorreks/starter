// apps/backend/live/src/protocol.ts
//
// The bytes that cross a live socket.
//
// Extracted from the Durable Object so both ends of the wire are defined once and
// so the encoding is testable without a runtime. A frame format that lives
// inline in the class that sends it has no second reference: the reader in the
// browser and the writer here can each be "obviously right" and still disagree
// about where the topic starts.
//
// **Why the tag is the first byte and nothing separates it from the payload.**
// The obvious encoding is `TAG + ':' + topic`, and it is wrong: this repository's
// topics are namespaced with a colon (`conversation:<id>`, `conversations`), so a
// colon separator would forbid every topic the application actually composes —
// and the natural "fix" of rejecting one would silently truncate
// `conversation:a:b` to `conversation:a`, a *real* topic, which is a
// subscription that is accepted and watching the wrong thing. A one-byte tag makes
// no such constraint necessary: the payload is simply everything after it.
//
// **Why text, not JSON.** There is exactly one field, the topic is already a
// string this codebase composes, and a parser that can fail is a parser that
// eventually will.

/** Ask the hub to watch a topic. */
export const SUBSCRIBE = '2';
/** The hub telling a subscriber that a topic may have moved. */
export const INVALIDATE = '1';

/**
 * The frame a client sends to subscribe.
 *
 * Refuses an empty topic, which would attach a socket that is watching nothing
 * and would never be told about anything.
 */
export const subscribeFrame = (topic: string): string | null =>
  topic.length === 0 ? null : `${SUBSCRIBE}${topic}`;

/** Read a client frame back into the topic it names, or `null` if it is not one. */
export const readSubscribeFrame = (raw: string): string | null => {
  if (raw[0] !== SUBSCRIBE) {
    return null;
  }
  const topic = raw.slice(1);
  return topic.length === 0 ? null : topic;
};

/** The frame the hub sends when a subscribed topic may have moved. */
export const invalidateFrame = (topic: string): Uint8Array =>
  new TextEncoder().encode(`${INVALIDATE}${topic}`);

/**
 * Read a hub frame back, so a client knows what it was told about.
 *
 * Returns `null` for anything else, which is the case that matters: a socket that
 * closed, or a proxy that sent something, must not be read as "your topic moved".
 */
export const readInvalidateFrame = (raw: string): string | null => {
  if (raw[0] !== INVALIDATE) {
    return null;
  }
  return raw.slice(1);
};

/** Why a topic was refused, so the client can say so rather than subscribing to nothing. */
export const topicRefusal = (topic: string): 'empty' | null =>
  topic.length === 0 ? 'empty' : null;

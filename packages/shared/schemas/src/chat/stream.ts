// packages/shared/schemas/src/chat/stream.ts
//
// Server-Sent Events framing, as this application uses it.
//
// Portable on purpose: the Worker encodes frames and the browser decodes them, and
// a parser in only one of those places is a protocol where one end can be right and
// the other wrong. Both follow the rules below, and the decoder here is what the
// round-trip test asserts the encoder against.
//
// **What `text/event-stream` gives and what it does not.** It gives framing,
// ordered delivery over one response, and a well-defined end. It does not give
// resumption: `Last-Event-ID` is honoured only if the server keeps a buffer, which
// this application does not, so a reconnect starts the turn again. That is stated in
// `docs/realtime.md` rather than papered over with an `id:` field that looks like
// resumption and is not.

import type { ChatStreamEvent } from './message.ts';

/** The `Content-Type` a streaming response must carry. */
export const SSE_CONTENT_TYPE = 'text/event-stream';

/**
 * The terminal marker every stream ends with, whatever happened.
 *
 * A stream that simply stops is a stream the client cannot tell apart from a
 * connection that was cut. An explicit sentinel means a reader can return "the turn
 * finished" and "the transport died" as different answers, which is the difference
 * between showing a completed message and showing a spinner forever.
 */
export const SSE_DONE_SENTINEL = '__done__';

/**
 * Encode one event as an SSE frame.
 *
 * `event:` names the frame's `type` so a browser's `EventSource` and a debugging
 * proxy both show which kind of frame this is, and `data:` carries the whole event
 * as JSON. The payload is *not* split across several `data:` lines: a JSON object
 * has no newlines in it, so a multi-line encoding would be a second framing format
 * for no benefit, and the decoder would then have to reassemble before it could
 * parse. `JSON.stringify` escaping is what makes that true — it escapes the control
 * characters a newline is.
 */
export const encodeSseFrame = (event: ChatStreamEvent): string => {
  const data = JSON.stringify(event);
  // One event, one blank line. The trailing blank line is the terminator, so
  // omitting it leaves the last frame buffered forever on a conforming client.
  return `event: ${event.type}\ndata: ${data}\n\n`;
};

/** The frame a well-behaved stream sends immediately before closing. */
export const encodeSseDone = (): string => `: ${SSE_DONE_SENTINEL}\n\n`;

/** A frame the decoder produced. `event` is the `event:` field, if any. */
export interface SseFrame {
  readonly event: string | null;
  readonly data: string;
}

/**
 * Decode a complete SSE body into frames.
 *
 * Takes the *whole* body rather than being an incremental parser, and that is a
 * deliberate limit. This decoder exists so the unit lane can prove the encoder and
 * the decoder agree without any streams involved; a streaming decoder is only
 * correct in the presence of a byte boundary a unit test cannot reproduce
 * faithfully. The browser's live reader is `readChatFrames` in
 * `packages/frontend/features/src/chat/chat_service.ts`, and it implements
 * the same field rules, so the two cannot disagree about a frame's shape.
 *
 * Rules implemented, all from the WHATWG event stream format:
 *   - a line beginning `:` is a comment, and is how the done sentinel travels
 *   - a field with no `:` has an empty value
 *   - a field with a leading space after `:` has exactly one space trimmed
 *   - a blank line dispatches the accumulated frame, if there was one
 *   - `data` lines accumulate joined by `\n`
 */
export const decodeSseFrames = (body: string): SseFrame[] => {
  const frames: SseFrame[] = [];
  let event: string | null = null;
  let data: string[] = [];

  const dispatch = (): void => {
    if (data.length > 0) {
      frames.push({ event, data: data.join('\n') });
    }
    event = null;
    data = [];
  };

  // Normalise line endings first. A stream split across chunks can end a line with
  // `\r\n`, and a decoder that does not see the terminator emits a field whose value
  // carries a trailing `\r` — which `JSON.parse` tolerates but which makes every
  // string comparison against an expected value fail for no visible reason.
  const lines = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  for (const line of lines) {
    if (line.length === 0) {
      dispatch();
      continue;
    }
    if (line.startsWith(':')) {
      // A comment. It is the done sentinel's carrier, and it never dispatches.
      continue;
    }

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }

    if (field === 'event') {
      event = value;
    } else if (field === 'data') {
      data.push(value);
    }
    // `id` and `retry` are ignored deliberately: see the note about `Last-Event-ID`
    // above. Emitting an `id:` the server does not honour would advertise a
    // resumption this application does not implement.
  }

  dispatch();
  return frames;
};

/**
 * Decode frames into chat events.
 *
 * A frame whose `data` is not valid JSON throws, with the offending payload in the
 * message. Silently skipping it would produce a stream that appears to work while
 * having lost a turn, and the user sees a missing reply rather than an error.
 */
export const decodeChatStream = (body: string): ChatStreamEvent[] =>
  decodeSseFrames(body).map((frame) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      throw new Error(`A stream frame was not valid JSON: ${frame.data.slice(0, 200)}`);
    }
    return parsed as ChatStreamEvent;
  });

/**
 * Whether a body carries the done sentinel.
 *
 * What the E2E and worker lanes assert about a completed turn: the bytes ended with
 * an explicit terminator, not with a dropped connection.
 */
export const sseBodyIsComplete = (body: string): boolean =>
  body.replace(/\r\n/g, '\n').includes(`: ${SSE_DONE_SENTINEL}\n`);

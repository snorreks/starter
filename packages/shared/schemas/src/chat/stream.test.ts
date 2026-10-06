// packages/shared/schemas/src/chat/stream.test.ts
//
// Two properties, and the second is the one that matters:
//
//   1. the encoder and the decoder agree, proven by round-tripping the encoder's
//      real output rather than a hand-written fixture that could drift from it;
//   2. the frame union is closed — a frame the Worker does not send is refused,
//      not ignored.
//
// The second is what stops a stream that "silently stopped" being misdiagnosed as
// a network problem.

import { describe, expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import {
  type ChatStreamEvent,
  isChatStreamEvent,
  isTerminalChatStreamEvent,
  MESSAGE_CONTENT_MAX_LENGTH,
  MESSAGE_ROLES,
  type Message,
  MessageCreateSchema,
  MessageRoleSchema,
  validateMessageInput,
} from './message.ts';
import {
  decodeChatStream,
  decodeSseFrames,
  encodeSseDone,
  encodeSseFrame,
  SSE_CONTENT_TYPE,
  sseBodyIsComplete,
} from './stream.ts';

const message = (overrides: Partial<Message> = {}): Message => ({
  id: 'msg_1',
  conversationId: 'cnv_1',
  authorId: 'usr_1',
  role: 'assistant',
  content: 'Hello.',
  status: 'complete',
  createdAt: 1_700_000_000_000,
  ...overrides,
});

describe('the streaming round trip', () => {
  test('a delta survives encode then decode unchanged', () => {
    const event: ChatStreamEvent = { type: 'delta', text: 'tok' };

    const decoded = decodeChatStream(encodeSseFrame(event));

    expect(decoded).toEqual([event]);
  });

  test('every frame type a turn can produce survives the round trip', () => {
    const frames: ChatStreamEvent[] = [
      { type: 'start', messageId: 'msg_1' },
      { type: 'user-message', clientId: 'c1', message: message({ role: 'user' }) },
      { type: 'delta', text: 'Hel' },
      { type: 'delta', text: 'lo' },
      { type: 'complete', message: message() },
    ];

    const body = frames.map(encodeSseFrame).join('');
    expect(decodeChatStream(body)).toEqual(frames);
  });

  test('a frame whose text contains a newline does not split into two frames', () => {
    // The property that makes `data:` safe to carry JSON: JSON.stringify escapes
    // the control character, so the encoder's output can never contain a bare
    // newline inside a payload.
    const event: ChatStreamEvent = { type: 'delta', text: 'line one\nline two' };

    const decoded = decodeChatStream(encodeSseFrame(event));

    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toEqual(event);
  });

  test('a frame whose text contains a double quote survives', () => {
    const event: ChatStreamEvent = { type: 'delta', text: 'she said "hi"' };

    expect(decodeChatStream(encodeSseFrame(event))).toEqual([event]);
  });

  test('the done sentinel is a comment and dispatches no frame', () => {
    const body = `${encodeSseFrame({ type: 'delta', text: 'x' })}${encodeSseDone()}`;

    expect(decodeSseFrames(body)).toHaveLength(1);
    expect(sseBodyIsComplete(body)).toBe(true);
  });

  test('a body without the sentinel is reported incomplete', () => {
    // The distinction the E2E lane asserts: a turn that finished is not
    // byte-identical to a connection that was cut.
    const body = encodeSseFrame({ type: 'complete', message: message() });

    expect(sseBodyIsComplete(body)).toBe(false);
  });

  test('a body using CRLF line endings decodes the same as one using LF', () => {
    const lf = `${encodeSseFrame({ type: 'delta', text: 'a' })}\n`;
    const crlf = lf.replace(/\n/g, '\r\n');

    expect(decodeSseFrames(crlf)).toEqual(decodeSseFrames(lf));
  });
});

describe('the decoder refuses what it cannot understand', () => {
  test('a frame that is not JSON throws rather than being skipped', () => {
    const body = 'event: delta\ndata: {not json\n\n';

    expect(() => decodeChatStream(body)).toThrow(/not valid JSON/);
  });

  test('a frame with an unknown type is refused by the union', () => {
    const body = 'event: delta\ndata: {"type":"teleport"}\n\n';
    const [frame] = decodeChatStream(body);

    expect(isChatStreamEvent(frame)).toBe(false);
  });

  test('a frame carrying an unknown field is refused', () => {
    // `additionalProperties: false` on every union member, which is what makes the
    // check a refusal rather than a coercion.
    const body = encodeSseFrame({ type: 'delta', text: 'a' }).replace(
      '"text":"a"',
      '"text":"a","role":"admin"',
    );
    const [frame] = decodeChatStream(body);

    expect(isChatStreamEvent(frame)).toBe(false);
  });

  test('every frame type the protocol declares passes its own check', () => {
    const valid: ChatStreamEvent[] = [
      { type: 'start', messageId: 'msg_1' },
      { type: 'user-message', clientId: 'c1', message: message({ role: 'user' }) },
      { type: 'delta', text: 'a' },
      { type: 'complete', message: message() },
      { type: 'error', code: 'model_unavailable', message: 'No model.' },
    ];

    for (const event of valid) {
      expect(isChatStreamEvent(event)).toBe(true);
    }
  });
});

describe('which frames end a turn', () => {
  test('only complete and error are terminal', () => {
    const terminal: ChatStreamEvent[] = [
      { type: 'complete', message: message() },
      { type: 'error', code: 'x', message: 'y' },
    ];
    const ongoing: ChatStreamEvent[] = [
      { type: 'start', messageId: 'msg_1' },
      { type: 'delta', text: 'a' },
      { type: 'user-message', clientId: 'c', message: message() },
    ];

    for (const event of terminal) {
      expect(isTerminalChatStreamEvent(event)).toBe(true);
    }
    for (const event of ongoing) {
      expect(isTerminalChatStreamEvent(event)).toBe(false);
    }
  });
});

describe('a message submitted to start a turn', () => {
  test('accepts content and the caller own id', () => {
    expect(MessageCreateSchema.properties).toHaveProperty('clientId');
    expect(MessageCreateSchema.properties).toHaveProperty('content');
  });

  test('refuses a role, so a caller cannot author an assistant turn', () => {
    // The authorization property, stated as a schema refusal. A caller that could
    // send `role: "assistant"` could write the one message in the table a human is
    // not supposed to write.
    expect(
      Value.Check(MessageCreateSchema, {
        content: 'hi',
        clientId: 'c1',
        role: 'assistant',
      }),
    ).toBe(false);
  });

  test('refuses a conversationId, so a caller cannot post into another conversation', () => {
    expect(
      Value.Check(MessageCreateSchema, {
        content: 'hi',
        clientId: 'c1',
        conversationId: 'cnv_other',
      }),
    ).toBe(false);
  });

  test('the role schema accepts exactly the two declared roles', () => {
    for (const role of MESSAGE_ROLES) {
      expect(Value.Check(MessageRoleSchema, role)).toBe(true);
    }
    expect(Value.Check(MessageRoleSchema, 'system')).toBe(false);
  });
});

describe('the composer agrees with the schema', () => {
  test('an empty message is refused with the message the composer shows', () => {
    expect(validateMessageInput({ content: '   ' })).toEqual({
      content: 'A message cannot be empty.',
    });
  });

  test('a message over the limit is refused at the same bound the schema enforces', () => {
    const over = 'x'.repeat(MESSAGE_CONTENT_MAX_LENGTH + 1);

    expect(validateMessageInput({ content: over })).toEqual({
      content: `A message must be ${MESSAGE_CONTENT_MAX_LENGTH} characters or fewer.`,
    });
  });

  test('a message at exactly the limit is accepted by both', () => {
    // The boundary, asserted on both sides at once: a client that refuses what the
    // Worker accepts is a form that shows an error for a request that would have
    // succeeded.
    const at = 'x'.repeat(MESSAGE_CONTENT_MAX_LENGTH);

    expect(validateMessageInput({ content: at })).toEqual({});
    expect(Value.Check(MessageCreateSchema, { content: at, clientId: 'c1' })).toBe(true);
  });

  test('an ordinary message is accepted', () => {
    expect(validateMessageInput({ content: 'hello' })).toEqual({});
  });
});

describe('the streaming content type', () => {
  test('is the one a streaming response must carry', () => {
    // Asserting the constant rather than restating it: a change here that is not a
    // change in the Worker's headers is what makes a browser silently buffer the
    // whole reply and deliver it at the end.
    expect(SSE_CONTENT_TYPE).toBe('text/event-stream');
  });
});

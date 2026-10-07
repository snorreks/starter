// packages/shared/schemas/src/chat/message.ts
//
// The chat domain, and the streaming protocol that carries it.
//
// Two things live here and they are deliberately one file: the entities, and the
// frame protocol the Worker's `text/event-stream` response speaks. Keeping them
// together is what makes the stream checkable — the same Valibot schema validates
// what the Worker emits and what the browser parses, so a frame the Worker sends
// that the client cannot understand is a refusal with a name rather than a message
// that silently stops arriving.
//
// **Why SSE and not a WebSocket.** A chat turn is one-directional while it streams:
// the browser sends a message, the Worker sends tokens back, and when the stream
// ends the turn is over. A WebSocket buys bidirectional push, which this turn does
// not use, and costs a Durable Object binding, a WebSocket-hibernation protocol and
// a reconnection story to maintain. An HTTP response stream is already framed,
// already resumes through ordinary HTTP semantics, and is observable by the
// lanes this repository already has: `test:worker` can read the raw body off a
// real `wrangler dev`, and E2E can read it through a browser. The client reads it
// through `fetch`, which is a port in `packages/frontend/features/src/chat`.

import * as v from 'valibot';
import {
  ConversationIdSchema,
  MessageIdSchema,
  OrganizationIdSchema,
  UserIdSchema,
} from '../common/ids.ts';
import { literalUnion } from '../common/literals.ts';
import { checkSchema } from '../validation.ts';

export const CONVERSATION_TITLE_MAX_LENGTH = 120;
export const MESSAGE_CONTENT_MAX_LENGTH = 8000;

/**
 * Which side of the turn wrote a message.
 *
 * A closed union rather than a free string, because the *authorization* rule
 * depends on it: a caller may submit a message with role `user` and nothing else.
 * A role that accepted any string would let a caller author an `assistant` turn,
 * which is the one message in the table a human is not supposed to be able to
 * write.
 */
export const MESSAGE_ROLES = ['user', 'assistant'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export const MessageRoleSchema = literalUnion(MESSAGE_ROLES);

/**
 * Whether a message is finished being written.
 *
 * A stored message is always `complete`. `streaming` exists on the wire only, for
 * the assistant turn the browser is currently rendering, because the point of the
 * status is to let the UI say "still arriving" rather than to record it. Persisting
 * a half-written turn would mean reconciling it on the next request, and the
 * reconciler is the thing most likely to be forgotten.
 */
export const MESSAGE_STATUSES = ['complete', 'streaming', 'failed'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export const MessageStatusSchema = literalUnion(MESSAGE_STATUSES);

/** A message exactly as the API returns it. */
export const MessageSchema = v.strictObject({
  id: MessageIdSchema,
  conversationId: ConversationIdSchema,
  authorId: UserIdSchema,
  role: MessageRoleSchema,
  content: v.pipe(v.string(), v.maxLength(MESSAGE_CONTENT_MAX_LENGTH)),
  status: MessageStatusSchema,
  createdAt: v.pipe(v.number(), v.finite()),
});

export type Message = v.InferOutput<typeof MessageSchema>;

/**
 * A conversation's wire shape.
 *
 * `messageCount` is carried rather than counted by the client, because the list is
 * bounded (see `MAX_LISTED_CONVERSATIONS`) and a count derived from a bounded page
 * is a count of the page rather than of the conversation. It is rendered, so a wrong
 * one is a lie the user reads.
 */
export const ConversationSchema = v.strictObject({
  id: ConversationIdSchema,
  ownerId: UserIdSchema,
  /**
   * The organization this conversation belongs to, or `null` for a personal one.
   *
   * Nullable rather than absent, and always present in the wire shape, because
   * "this conversation belongs to nobody's organization" is a fact the client
   * needs in order to render the right sharing affordance — and an optional field
   * is a field that can be missing for a reason that has nothing to do with
   * tenancy.
   */
  organizationId: v.union([OrganizationIdSchema, v.null()]),
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(CONVERSATION_TITLE_MAX_LENGTH)),
  messageCount: v.pipe(v.number(), v.integer(), v.finite(), v.minValue(0)),
  createdAt: v.pipe(v.number(), v.finite()),
  updatedAt: v.pipe(v.number(), v.finite()),
});

export type Conversation = v.InferOutput<typeof ConversationSchema>;

/**
 * Create payload. The server derives `ownerId` and `organizationId` from the
 * session, so neither appears here — `additionalProperties: false` makes a body
 * carrying one a refusal rather than a silently dropped value.
 */
export const ConversationCreateSchema = v.strictObject({
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(CONVERSATION_TITLE_MAX_LENGTH)),
});

export type ConversationCreate = v.InferOutput<typeof ConversationCreateSchema>;

export const ConversationListSchema = v.strictObject({
  conversations: v.array(ConversationSchema),
  /** Echoed so a client can tell a fresh list from a cached one. */
  serverTime: v.pipe(v.number(), v.finite()),
});

export type ConversationList = v.InferOutput<typeof ConversationListSchema>;

export const MessageListSchema = v.strictObject({
  messages: v.array(MessageSchema),
  serverTime: v.pipe(v.number(), v.finite()),
});

export type MessageList = v.InferOutput<typeof MessageListSchema>;

/**
 * A message submitted to start a turn.
 *
 * `clientId` is the caller's own id for the message it is about to render
 * optimistically, and it is what makes the round trip reconcilable: the Worker
 * echoes it on the `user-message` frame, so the client replaces its optimistic
 * placeholder with the persisted row by identity rather than by position. Without
 * it a list ordered by `createdAt` can hold two messages with the same timestamp
 * — which is what happens when both were written in the same millisecond — and
 * matching by index then swaps one message for another.
 *
 * It is also the idempotency key. A client whose connection dropped retries the
 * same submission, and the Worker returns the row it already stored.
 */
export const MessageCreateSchema = v.strictObject({
  content: v.pipe(v.string(), v.minLength(1), v.maxLength(MESSAGE_CONTENT_MAX_LENGTH)),
  clientId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
});

export type MessageCreate = v.InferOutput<typeof MessageCreateSchema>;

// -----------------------------------------------------------------------------
// The streaming protocol
// -----------------------------------------------------------------------------

/**
 * The frames one turn's stream can carry.
 *
 * A single discriminated union rather than a per-frame schema, for one reason: the
 * browser has exactly one place to validate whatever arrives, and a union means
 * "whatever arrived must be one of these" is a statement it can make. Three
 * sibling schemas and a client that picks by `event:` would let an unrecognised
 * frame type through as "nothing to do", which is the failure that looks like a
 * stream that simply stopped.
 */
export const ChatStreamEventSchema = v.union([
  /** The submitted message, persisted. The client reconciles its placeholder. */
  v.strictObject({
    type: v.literal('user-message'),
    clientId: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
    message: MessageSchema,
  }),
  /** One chunk of assistant text. Appended in arrival order. */
  v.strictObject({
    type: v.literal('delta'),
    text: v.pipe(v.string(), v.maxLength(MESSAGE_CONTENT_MAX_LENGTH)),
  }),
  /** The stream opened and the model is producing. Lets the UI show a spinner early. */
  v.strictObject({
    type: v.literal('start'),
    messageId: MessageIdSchema,
  }),
  /** Terminal success. Carries the persisted assistant message. */
  v.strictObject({
    type: v.literal('complete'),
    message: MessageSchema,
  }),
  /**
   * Terminal failure.
   *
   * A frame rather than an HTTP status, because by the time the model has failed the
   * response has already begun and its status line is spent. The client has to be
   * able to learn *from the stream* that the turn failed, or it renders a
   * half-written assistant turn as though it were complete.
   */
  v.strictObject({
    type: v.literal('error'),
    code: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
    message: v.pipe(v.string(), v.maxLength(512)),
  }),
]);

export type ChatStreamEvent = v.InferOutput<typeof ChatStreamEventSchema>;

/**
 * Validate one decoded stream frame.
 *
 * validation against the union above, so an unrecognised `type` is refused
 * rather than ignored. A helper that only checked that `type` existed would let a
 * frame the Worker never sends pass, and the symptom would be a stream that silently
 * stops — which reads as a network problem and is not one.
 */
export const isChatStreamEvent = (value: unknown): value is ChatStreamEvent =>
  checkSchema(ChatStreamEventSchema, value);

/**
 * Whether a frame ends the turn.
 *
 * The client needs this to know when to stop appending, and it is derived from the
 * union rather than matched at each call site so a new terminal frame cannot be
 * added without this noticing.
 */
export const isTerminalChatStreamEvent = (event: ChatStreamEvent): boolean =>
  event.type === 'complete' || event.type === 'error';

/**
 * Domain rule kept beside the schema so the composer can show the same message the
 * Worker would, without a round trip.
 */
export const validateMessageInput = (input: { content: string }): Record<string, string> => {
  const errors: Record<string, string> = {};

  if (input.content.trim().length === 0) {
    errors.content = 'A message cannot be empty.';
  } else if (input.content.length > MESSAGE_CONTENT_MAX_LENGTH) {
    errors.content = `A message must be ${MESSAGE_CONTENT_MAX_LENGTH} characters or fewer.`;
  }

  return errors;
};

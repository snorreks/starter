// packages/frontend/features/src/chat/chat_service.ts
//
// The client's half of chat: two REST calls and one stream.
//
// The stream is read with `fetch` and a `ReadableStream` reader rather than
// `EventSource`. That is not a preference:
//
//   - `EventSource` is GET-only, so it cannot carry the request body a turn needs;
//   - it cannot send an `Authorization` header, so a native shell holding a bearer
//     token instead of a cookie could not use it at all;
//   - it reconnects on its own, which for a *write* is a duplicated submission.
//
// So this is a hand-written reader, and the frame format it parses is the one in
// `@starter/schemas/chat` — the same encoder the Worker uses, not a second
// implementation of the same idea.
//
// **Why every answer is checked with `parseDto`.** `stream<unknown>()` compiles
// identically whether the Worker sent frames, an error envelope, or a proxy's HTML
// page. Without the check, an HTML error page decodes to no frames, the turn
// silently produces nothing, and the user watches an empty reply arrive as though
// the model had thought about it. The thrown `AppError` is what turns that into a
// visible failure.

import { parseDto, type StreamingTransport } from '@starter/platform';
import {
  type Conversation,
  type ConversationCreate,
  ConversationListSchema,
  ConversationSchema,
  isChatStreamEvent,
  type Message,
  MessageListSchema,
  MessagePageSchema,
} from '@starter/schemas/chat';
import { AppError } from '@starter/utils';
import { readChatFrames } from './chat_stream.ts';

/** Each update has exactly one protocol meaning. */
type Update =
  | { type: 'user-message'; userMessage: Message; clientId: string }
  | { type: 'start'; replyId: string }
  | { type: 'delta'; delta: string }
  | { type: 'complete'; complete: Message }
  | { type: 'error'; failure: { readonly code: string; readonly message: string } };
type UpdateKeys = 'userMessage' | 'clientId' | 'replyId' | 'delta' | 'complete' | 'failure';
type Exclusive<U> = U extends Update
  ? U & Partial<Record<Exclude<UpdateKeys, keyof U>, never>>
  : never;
export type ChatStreamUpdate = Exclusive<Update>;

/** Terminal summary; event history is opt-in for diagnostics. */
export interface StreamTurnResult {
  readonly events: readonly ChatStreamUpdate[];
  readonly text?: string;
  readonly message?: Message;
  readonly failure?: { readonly code: string; readonly message: string };
}

export interface ChatServiceOptions {
  readonly transport: StreamingTransport;
  readonly onUpdate?: (update: ChatStreamUpdate) => void;
  readonly retainEvents?: boolean;
}

export class ChatService {
  readonly className: string;
  readonly #transport: StreamingTransport;
  readonly #onUpdate: ((update: ChatStreamUpdate) => void) | undefined;
  readonly #retainEvents: boolean;

  constructor(options: ChatServiceOptions) {
    this.className = 'ChatService';
    this.#transport = options.transport;
    this.#onUpdate = options.onUpdate;
    this.#retainEvents = options.retainEvents ?? false;
  }

  async listConversations(signal?: AbortSignal): Promise<Conversation[]> {
    const body = await this.#transport.request<unknown>('/api/chat/conversations', {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
    return parseDto(ConversationListSchema, body, 'a conversation list').conversations;
  }

  async createConversation(input: ConversationCreate, signal?: AbortSignal): Promise<Conversation> {
    const body = await this.#transport.request<unknown>('/api/chat/conversations', {
      method: 'POST',
      body: input,
      ...(signal === undefined ? {} : { signal }),
    });
    return parseDto(ConversationSchema, body, 'a conversation');
  }

  async listMessages(conversationId: string, signal?: AbortSignal): Promise<Message[]> {
    const body = await this.#transport.request<unknown>(
      `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
      { method: 'GET', ...(signal === undefined ? {} : { signal }) },
    );
    return parseDto(MessageListSchema, body, 'a message list').messages;
  }

  async listMessagesPage(conversationId: string, cursor: string | null, signal?: AbortSignal) {
    const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
    const body = await this.#transport.request<unknown>(
      `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages/page${query}`,
      { method: 'GET', ...(signal === undefined ? {} : { signal }) },
    );
    return parseDto(MessagePageSchema, body, 'a message page');
  }

  /**
   * Send a message and consume the reply as it streams.
   *
   * Resolves when the turn ends — successfully or not — and rejects only for a
   * failure the stream could not report itself: a non-2xx response before the
   * first frame, a frame that is not one the protocol declares, or a network error.
   * A model failure arrives as a resolved result carrying `failure`, because by then
   * the HTTP status was spent and the caller still needs to distinguish "the reply
   * is over" from "the reply failed".
   */
  async streamTurn(
    conversationId: string,
    input: { content: string; clientId: string },
    signal?: AbortSignal,
    onUpdate?: (update: ChatStreamUpdate) => void,
  ): Promise<StreamTurnResult> {
    const path = `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`;
    const response = await this.#transport.openStream(path, {
      method: 'POST',
      body: input,
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.body === null) {
      throw new AppError('server', 'The server sent a reply with no body.');
    }

    const events: ChatStreamUpdate[] = [];
    let terminal = false;
    let message: Message | undefined;
    let failure: { code: string; message: string } | undefined;

    for await (const event of readChatFrames(response.body)) {
      if (!isChatStreamEvent(event)) {
        // A frame the protocol does not declare. Refused rather than skipped: a
        // skipped frame loses a turn, and the symptom is a reply that stops halfway
        // with no error anywhere.
        throw new AppError(
          'server',
          'The server sent a stream frame this build does not understand.',
          {
            status: response.status,
            cause: event,
          },
        );
      }

      let update: ChatStreamUpdate;
      switch (event.type) {
        case 'user-message':
          update = { type: 'user-message', userMessage: event.message, clientId: event.clientId };
          break;
        case 'start':
          update = { type: 'start', replyId: event.messageId };
          break;
        case 'delta':
          update = { type: 'delta', delta: event.text };
          break;
        case 'complete':
          terminal = true;
          message = event.message;
          update = { type: 'complete', complete: event.message };
          break;
        case 'error':
          terminal = true;
          failure = { code: event.code, message: event.message };
          update = { type: 'error', failure };
          break;
      }

      if (this.#retainEvents) {
        events.push(update);
      }
      onUpdate?.(update);
      this.#onUpdate?.(update);
      if (terminal) {
        break;
      }
    }

    if (!terminal) {
      failure = { code: 'truncated', message: 'The reply ended before the turn completed.' };
      const update: ChatStreamUpdate = { type: 'error', failure };
      if (this.#retainEvents) {
        events.push(update);
      }
      onUpdate?.(update);
      this.#onUpdate?.(update);
    }

    return {
      events,
      ...(failure === undefined
        ? { ...(message === undefined ? {} : { text: message.content, message }) }
        : { failure }),
    };
  }
}

export { readChatFrames } from './chat_stream.ts';

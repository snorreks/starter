// packages/frontend/features/src/chat/chat_service.svelte.ts
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

import { type ApiTransport, type FetchLike, parseDto } from '@starter/platform';
import {
  type Conversation,
  type ConversationCreate,
  ConversationListSchema,
  ConversationSchema,
  type Message,
  MessageListSchema,
  isChatStreamEvent,
} from '@starter/schemas/chat';
import { AppError } from '@starter/utils';

/** One event from a turn's stream, as the caller receives it. */
export interface ChatStreamUpdate {
  /** The submitted message, once the server has stored it. */
  readonly userMessage?: Message;
  /** The id of the reply the model is producing. Announced once. */
  readonly replyId?: string;
  /** One chunk of reply text. Appended in arrival order. */
  readonly delta?: string;
  /** The stored reply, at the end of a successful turn. */
  readonly complete?: Message;
  /** The turn failed, with the reason the Worker gave. */
  readonly failure?: { readonly code: string; readonly message: string };
}

/** The terminal outcome of a stream the caller awaited. */
export interface StreamTurnResult {
  readonly events: readonly ChatStreamUpdate[];
  /** The full reply text, concatenated. Present on success. */
  readonly text?: string;
  /** The stored reply. Present on success. */
  readonly message?: Message;
  /** The failure. Present on a terminal `error` frame. */
  readonly failure?: { readonly code: string; readonly message: string };
}

export interface ChatServiceOptions {
  readonly transport: ApiTransport;
  /**
   * Called for every frame, as it arrives.
   *
   * Invoked rather than only returned, because the caller's UI has to append
   * `delta`s while they arrive. A method that returned an array would give the
   * caller the whole reply only after the last chunk — the same bytes, none of the
   * streaming, which is the entire reason this endpoint streams.
   */
  readonly onUpdate?: (update: ChatStreamUpdate) => void;
  /**
   * Streams `fetch`. Injected so a test drives a real reader, not a mock of one.
   *
   * Typed as `FetchLike` rather than `typeof fetch`, and that is not a loosening:
   * Bun adds `fetch.preconnect` to its own type, so `typeof fetch` there is a
   * *narrower* requirement than the browser's, and assigning the browser's to a
   * field typed with it is an error. `FetchLike` is the same narrowing
   * `@starter/platform`'s `HttpTransport` already uses, so both halves of the
   * client speak about fetching the same way.
   */
  readonly fetch?: FetchLike;
}

export class ChatService {
  readonly className: string;
  readonly #transport: ApiTransport;
  readonly #onUpdate: ((update: ChatStreamUpdate) => void) | undefined;
  readonly #fetch: FetchLike;

  constructor(options: ChatServiceOptions) {
    this.className = 'ChatService';
    this.#transport = options.transport;
    this.#onUpdate = options.onUpdate;
    // Resolved at call time, not at construction: a test installs a stub between
    // the two, and the browser half must reach the real global.
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
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
  ): Promise<StreamTurnResult> {
    const path = `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`;
    const headers: Record<string, string> = {
      accept: 'text/event-stream',
      'content-type': 'application/json',
    };

    // The credential header the transport would have added, applied here because
    // `fetch` is not the transport. A native shell's bearer token arrives this way;
    // without it a stream would be the one call on the page that is anonymous.
    const sessionToken = this.#transportHeader('authorization');
    if (sessionToken !== undefined) {
      headers.authorization = sessionToken;
    }

    const response = await this.#fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
      credentials: 'include',
      ...(signal === undefined ? {} : { signal }),
    });

    if (!response.ok) {
      // Read as text, then try JSON: a proxy's HTML and the Worker's envelope are
      // both possible here, and the two produce different `AppError`s.
      const text = await response.text();
      throw new AppError(errorTypeFor(response.status), messageFrom(text), {
        status: response.status,
        cause: text.slice(0, 500),
      });
    }

    if (response.body === null) {
      throw new AppError('server', 'The server sent a reply with no body.', {
        status: response.status,
      });
    }

    const events: ChatStreamUpdate[] = [];
    let text = '';
    let message: Message | undefined;
    let failure: { code: string; message: string } | undefined;

    for await (const event of readChatFrames(response.body)) {
      if (!isChatStreamEvent(event)) {
        // A frame the protocol does not declare. Refused rather than skipped: a
        // skipped frame loses a turn, and the symptom is a reply that stops halfway
        // with no error anywhere.
        throw new AppError('server', 'The server sent a stream frame this build does not understand.', {
          status: response.status,
          cause: event,
        });
      }

      switch (event.type) {
        case 'user-message':
          events.push({ userMessage: event.message });
          break;
        case 'start':
          events.push({ replyId: event.messageId });
          break;
        case 'delta':
          text += event.text;
          events.push({ delta: event.text });
          break;
        case 'complete':
          message = event.message;
          events.push({ complete: event.message });
          break;
        case 'error':
          failure = { code: event.code, message: event.message };
          events.push({ failure });
          break;
      }

      this.#onUpdate?.(events[events.length - 1] as ChatStreamUpdate);
    }

    return {
      events,
      ...(failure === undefined ? { text, ...(message === undefined ? {} : { message }) } : { failure }),
    };
  }

  /**
   * The transport's own `authorization` default, if it has one.
   *
   * Read through the contract rather than by having the service hold a token: the
   * transport is what knows how this host authenticates, and a second copy of that
   * knowledge here is a second thing to keep in step. Returns `undefined` for the
   * browser host, which authenticates with a cookie and sets no such header.
   */
  #transportHeader(name: string): string | undefined {
    const headers = (this.#transport as { headers?: Readonly<Record<string, string>> }).headers;
    const value = headers?.[name.toLowerCase()];
    return typeof value === 'string' ? value : undefined;
  }
}

/**
 * Read one stream into frames, incrementally.
 *
 * A hand-written reader rather than the decoder in `@starter/schemas/chat`, and
 * that split is deliberate: the shared decoder takes a whole body and exists so the
 * encoder and decoder can be proved to agree in a unit test with no streams
 * involved. This one has to work across arbitrary chunk boundaries, which is a
 * different problem — a frame can be split mid-JSON by the network, and a reader
 * that assumed otherwise would drop or corrupt it.
 *
 * The buffer holds decoded *text*, not bytes, and a partial UTF-8 sequence at a
 * chunk boundary would be a real hazard if it did — so `TextDecoder` is used with
 * `stream: true`, which carries an incomplete sequence over to the next chunk.
 */
export async function* readChatFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // Dispatch every *complete* frame: one that ends in the blank line that
      // terminates it. A trailing partial frame stays in the buffer for the next
      // chunk, which is what makes a frame split across two reads still parse.
      for (;;) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary === -1) {
          break;
        }
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseOneFrame(raw);
        if (parsed !== undefined) {
          yield parsed;
        }
      }
    }

    // Whatever is left after the final read. A stream that ended mid-frame is
    // malformed, and `parseOneFrame` refuses it rather than yielding a partial one.
    const tail = parseOneFrame(buffer);
    if (tail !== undefined) {
      yield tail;
    }
  } finally {
    // Releasing the lock is what lets the caller's abort actually cancel the
    // request; without it the response body stays open after the reader is done.
    reader.releaseLock();
  }
}

/**
 * Parse one frame's raw text, or `undefined` for a frame that carries no data.
 *
 * Comment-only frames — which is how the done sentinel travels — yield nothing.
 * That is the point of the sentinel: it marks the end of the stream without adding
 * a frame type the protocol would then have to declare.
 */
const parseOneFrame = (raw: string): unknown => {
  const dataLines: string[] = [];

  for (const line of raw.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) {
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  const joined = dataLines.join('\n');
  try {
    return JSON.parse(joined) as unknown;
  } catch {
    // Returned as a non-frame marker so the caller's `isChatStreamEvent` check is
    // what refuses it — one place decides what a valid frame is, not two.
    return { __unparseable: joined.slice(0, 200) };
  }
};

const errorTypeFor = (status: number): AppError['errorType'] => {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 413) return 'validation';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'validation';
};

const messageFrom = (text: string): string => {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === 'string') {
      return parsed.message;
    }
  } catch {
    // Not JSON. A proxy's HTML reaches here.
  }
  return text.length === 0 ? 'The request failed.' : text.slice(0, 200);
};
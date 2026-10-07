// apps/frontend/client/src/routes/api/chat/conversations/[id]/messages/+server.ts
//
// The streaming endpoint: one turn, one response, Server-Sent Events.
//
// **Why POST rather than GET.** A turn writes a row and calls a model. `GET` is for
// reading, and a browser will not send a body with one. `EventSource` cannot be used
// either — it is GET-only and cannot carry credentials or a body — which is exactly
// why the browser half reads this response with `fetch` and parses the frames
// itself. That is a real constraint of the platform, not a preference.
//
// **Why the status line is not where failures are reported.** Once the first frame
// is written the response has begun and the status is spent: a model that fails on
// the third chunk cannot change the 200 it already sent. So the stream ends with an
// `error` *frame*, and the client's only way to learn the turn failed is to read
// one. That is why `ChatStreamEventSchema` is a closed union including that frame,
// and why the terminal sentinel exists — a stream that simply stops is
// indistinguishable from a connection that was cut.
//
// **What is checked before the first byte.** Ownership (`find` returns `null` for
// another owner's conversation, and the answer is the same 404), the body against
// `MessageCreateSchema` with a byte ceiling, and the caller-supplied `clientId`,
// which the service treats as an idempotency key. All three answer with a status
// code; none of them can answer after the stream has started.
//
// **What the abort signal is for.** A browser that navigates away aborts the fetch,
// `request.signal` fires, the model stops generating, and no tokens are produced for
// a reader who has gone.

import {
  type ChatStreamEvent,
  encodeSseDone,
  encodeSseFrame,
  MESSAGE_CONTENT_MAX_LENGTH,
  type Message,
  MessageCreateSchema,
  type MessageList,
  SSE_CONTENT_TYPE,
} from '@starter/schemas/chat';
import { createId } from '@starter/utils';
import { createRequestChatService } from '#lib/server/application_chat.ts';
import type { ChatModel } from '#lib/server/chat_model.ts';
import { json, jsonError, readJsonBody, unauthorized } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/**
 * A submitted message is one field; the ceiling is the schema's own bound plus slack
 * for JSON escaping. Both are stated because a ceiling derived from
 * `MESSAGE_CONTENT_MAX_LENGTH` alone would refuse a legal body whose content
 * happened to contain characters that expand when encoded.
 */
const MAX_MESSAGE_BODY_BYTES = MESSAGE_CONTENT_MAX_LENGTH * 2 + 1024;

/**
 * Headers a streaming response must carry.
 *
 * `no-cache` and `no-transform` are not decoration. A proxy that buffers the
 * response defeats streaming entirely — the client receives one chunk at the end
 * rather than many over time, and every assertion about incremental delivery fails
 * while the content still arrives. `X-Accel-Buffering: no` is the same instruction
 * for nginx, which ignores the standard header.
 */
const SSE_HEADERS = {
  'content-type': `${SSE_CONTENT_TYPE}; charset=utf-8`,
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

/** The history, for a client rendering a conversation it has not streamed. */
export const GET: RequestHandler = async ({ locals, params }) => {
  const user = locals.user;
  if (user === null) {
    return unauthorized();
  }

  const service = createRequestChatService(locals);
  const conversation = await service.find(user.id, params.id);
  if (conversation === null) {
    // 404 rather than 403, deliberately: a 403 would confirm the conversation
    // exists, turning this endpoint into an existence oracle for other users' data.
    return jsonError(404, 'not_found', 'That conversation does not exist.');
  }

  const body: MessageList = {
    messages: await service.messages(user.id, params.id),
    serverTime: Date.now(),
  };
  return json(200, body);
};

/** One turn: persist the caller's message, then stream the model's reply. */
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const user = locals.user;
  if (user === null) {
    return unauthorized();
  }

  const service = createRequestChatService(locals);
  const conversation = await service.find(user.id, params.id);
  if (conversation === null) {
    return jsonError(404, 'not_found', 'That conversation does not exist.');
  }

  const body = await readJsonBody(request, MessageCreateSchema, {
    maxBytes: MAX_MESSAGE_BODY_BYTES,
  });
  if (!body.ok) {
    return body.response;
  }

  const { content, clientId } = body.value;

  // Before the first frame, so a failure here is still an HTTP status. Idempotent on
  // `clientId`: a retry after a dropped connection returns the same row rather than
  // writing the user's message twice.
  const userMessage = await service.appendUserMessage(user.id, params.id, content, clientId);
  if (userMessage === null) {
    return jsonError(404, 'not_found', 'That conversation does not exist.');
  }

  // Announced before the reply exists, and stored under this id afterwards. See
  // `appendAssistantMessage`: a row whose id the client was never told would make the
  // `complete` frame disagree with the `start` frame.
  const replyId = createId('msg');

  return streamTurn({
    model: locals.container.chatModel,
    prompt: content,
    replyId,
    conversationId: params.id,
    userMessage,
    clientId,
    signal: request.signal,
    persistAssistantReply: async (text, id, createdAt) =>
      service.appendAssistantMessage(user.id, params.id, text, id, createdAt),
  });
};

export interface StreamTurnOptions {
  readonly model: ChatModel;
  readonly prompt: string;
  /** The id the `start` frame announces and the reply is stored under. */
  readonly replyId: string;
  readonly conversationId: string;
  readonly userMessage: Message;
  readonly clientId: string;
  readonly signal: AbortSignal;
  /**
   * Store the completed reply, returning the stored row.
   *
   * Returns rather than accepting `void` so the `complete` frame carries the row the
   * database actually holds — including the server's own `createdAt`. A frame
   * carrying a locally-assembled row would show the client a timestamp and an id
   * that need not match the next `GET`.
   */
  readonly persistAssistantReply: (
    text: string,
    id: string,
    createdAt: number,
  ) => Promise<Message | null>;
}

/**
 * The response stream itself.
 *
 * Exported so the worker lane can drive it directly and assert the frames — the
 * bytes are the contract, and the only way to check them is to read them off a real
 * response rather than to trust the encoder.
 *
 * Four properties this function owns:
 *
 *   1. **Order.** `user-message`, then `start`, then every `delta`, then exactly one
 *      terminal frame. The client's reconciliation depends on the persisted row
 *      arriving before the deltas that follow it.
 *   2. **Exactly one terminal frame.** Both the success and failure paths emit one;
 *      a stream that can end twice or not at all cannot be reasoned about.
 *   3. **The sentinel.** Emitted after the terminal frame, so a reader can tell a
 *      finished turn from a dropped connection even ignoring frame types.
 *   4. **One `pull` per frame.** Each `pull` enqueues at most one frame and returns,
 *      which is what makes the runtime flush incrementally. Collecting every chunk
 *      and enqueueing once at the end would produce byte-identical output with none
 *      of the timing — and the timing is the feature.
 */
/** Internal stream handler — not a SvelteKit route export. */
const streamTurn = (options: StreamTurnOptions): Response => {
  const encoder = new TextEncoder();

  // Stream state. Declared outside the `ReadableStream` so `cancel` can reach it: a
  // cancelled stream's `pull` must not enqueue, and the flag is what stops it.
  let started = false;
  let done = false;
  let collected = '';
  let createdAt = Date.now();

  /** The one iterator for this turn, created lazily on the first delta. */
  let iterator: AsyncIterator<{ readonly text: string }> | undefined;
  let exhausted = false;

  const emit = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: ChatStreamEvent,
  ): void => {
    controller.enqueue(encoder.encode(encodeSseFrame(event)));
  };

  const finish = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    event: ChatStreamEvent,
  ): void => {
    emit(controller, event);
    controller.enqueue(encoder.encode(encodeSseDone()));
    controller.close();
  };

  const completeTurn = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> => {
    const stored = await options.persistAssistantReply(collected, options.replyId, createdAt);
    if (stored === null) {
      finish(controller, {
        type: 'error',
        code: 'not_persisted',
        message: 'The reply could not be saved.',
      });
      return;
    }
    finish(controller, { type: 'complete', message: stored });
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (done) {
        controller.close();
        return;
      }

      try {
        if (!started) {
          started = true;
          createdAt = Date.now();
          emit(controller, {
            type: 'user-message',
            clientId: options.clientId,
            message: options.userMessage,
          });
          emit(controller, { type: 'start', messageId: options.replyId });
          return;
        }

        if (options.signal.aborted) {
          done = true;
          finish(controller, {
            type: 'error',
            code: 'aborted',
            message: 'The request was cancelled.',
          });
          return;
        }

        if (exhausted) {
          done = true;
          await completeTurn(controller);
          return;
        }

        iterator ??= options.model.generate(options.prompt, options.signal)[Symbol.asyncIterator]();

        const next = await iterator.next();

        if (done) {
          return;
        }
        if (options.signal.aborted) {
          done = true;
          finish(controller, {
            type: 'error',
            code: 'aborted',
            message: 'The request was cancelled.',
          });
          void iterator.return?.();
          return;
        }

        if (next.done === true) {
          exhausted = true;
          done = true;
          await completeTurn(controller);
          return;
        }

        collected += next.value.text;
        emit(controller, { type: 'delta', text: next.value.text });
      } catch (error) {
        done = true;
        finish(controller, {
          type: 'error',
          code: 'model_failed',
          message: error instanceof Error ? error.message.slice(0, 512) : 'The model failed.',
        });
      }
    },
    cancel() {
      // The browser went away. Marking the turn done is what stops the next `pull`
      // from enqueuing into a cancelled stream, and releasing the iterator stops the
      // model generating tokens nobody will read.
      done = true;
      void iterator?.return?.();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
};

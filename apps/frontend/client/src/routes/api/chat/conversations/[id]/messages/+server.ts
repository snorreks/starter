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
import {
  CHAT_GENERATION_DEADLINE_MS,
  CHAT_OUTPUT_MAX_BYTES,
  CHAT_PROMPT_MAX_BYTES,
} from '#lib/server/chat_model.ts';
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
  const history = (await service.messagePage(user.id, params.id, null)).items
    .filter((message) => message.clientId !== clientId)
    .map((message) => `${message.role}: ${message.content}`);
  const prompt = buildBoundedPrompt(history, `user: ${content}`);
  if (prompt === null) {
    return jsonError(413, 'prompt_too_large', 'The new message exceeds the prompt byte budget.');
  }

  // Before the first frame, so a failure here is still an HTTP status. Idempotent on
  // `clientId`: a retry after a dropped connection returns the same row rather than
  // writing the user's message twice.
  let admission: Awaited<ReturnType<typeof service.appendUserMessage>>;
  try {
    admission = await service.appendUserMessage(user.id, params.id, content, clientId);
  } catch (error) {
    if (error instanceof Error && error.message.includes('owner chat concurrency limit reached')) {
      return jsonError(
        429,
        'owner_concurrency',
        'The active generation limit has been reached. Retry shortly.',
      );
    }
    if (error instanceof Error && error.message.includes('chat admission limit reached')) {
      return jsonError(429, 'admission_quota', 'The hourly generation quota has been reached.');
    }
    throw error;
  }
  if (admission === null) {
    return jsonError(404, 'not_found', 'That conversation does not exist.');
  }

  // Announced before the reply exists, and stored under this id afterwards. See
  // `appendAssistantMessage`: a row whose id the client was never told would make the
  // `complete` frame disagree with the `start` frame.
  if ('outcome' in admission && admission.outcome === 'conflict') {
    return jsonError(
      409,
      'conflict',
      'This idempotency key was already used with different content.',
    );
  }
  if ('outcome' in admission && admission.outcome === 'running') {
    return new Response(
      JSON.stringify({
        code: 'running',
        generationId: admission.assistantMessageId,
        recoverable: true,
      }),
      {
        status: 409,
        headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
      },
    );
  }
  if ('outcome' in admission && admission.outcome === 'completed') {
    const events: ChatStreamEvent[] = [
      { type: 'user-message', clientId, message: admission.userMessage },
      { type: 'start', messageId: admission.assistantMessage.id },
      { type: 'complete', message: admission.assistantMessage },
    ];
    return new Response(events.map(encodeSseFrame).join('') + encodeSseDone(), {
      status: 200,
      headers: SSE_HEADERS,
    });
  }
  const userMessage = 'outcome' in admission ? admission.userMessage : admission;
  const replyId = 'outcome' in admission ? admission.assistantMessageId : createId('msg');

  const response = _streamTurn({
    model: locals.container.chatModel,
    prompt,
    replyId,
    conversationId: params.id,
    userMessage,
    clientId,
    signal: request.signal,
    persistAssistantReply: async (text, id, createdAt) =>
      service.appendAssistantMessage(user.id, params.id, text, id, createdAt),
    failGeneration: (state) => service.failGeneration(user.id, params.id, clientId, state),
    deadlineMs: CHAT_GENERATION_DEADLINE_MS,
    maxOutputBytes: CHAT_OUTPUT_MAX_BYTES,
    onTerminal: (outcome, elapsedMs) => {
      const logger = locals.context?.logger;
      if (logger === undefined) {
        return;
      }
      const logTypes = {
        completed: { logLevel: 'INFO', logType: 'info' },
        failed: { logLevel: 'ERROR', logType: 'error' },
        cancelled: { logLevel: 'WARNING', logType: 'warn' },
      } as const;
      logger.write({
        ...logTypes[outcome],
        event: 'chat.generation.outcome',
        data: {
          outcome,
          elapsedMs,
          conversationId: params.id,
          generationId: replyId,
        },
      });
    },
  });
  return response;
};

const buildPrompt = (messages: readonly string[]): string => messages.slice(-20).join('\n');

const buildBoundedPrompt = (history: readonly string[], current: string): string | null => {
  const encoder = new TextEncoder();
  if (encoder.encode(current).byteLength > CHAT_PROMPT_MAX_BYTES) {
    return null;
  }
  const bounded = [...history, current].slice(-20);
  while (
    encoder.encode(buildPrompt(bounded)).byteLength > CHAT_PROMPT_MAX_BYTES &&
    bounded.length > 1
  ) {
    bounded.shift();
  }
  return encoder.encode(buildPrompt(bounded)).byteLength <= CHAT_PROMPT_MAX_BYTES
    ? buildPrompt(bounded)
    : null;
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
  readonly deadlineMs?: number;
  readonly maxOutputBytes?: number;
  readonly onTerminal?: (outcome: 'completed' | 'failed' | 'cancelled', elapsedMs: number) => void;
  readonly failGeneration?: (state: 'failed' | 'cancelled') => Promise<void>;
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
export const _streamTurn = (options: StreamTurnOptions): Response => {
  const encoder = new TextEncoder();

  // Stream state. Declared outside the `ReadableStream` so `cancel` can reach it: a
  // cancelled stream's `pull` must not enqueue, and the flag is what stops it.
  let started = false;
  let done = false;
  let collected = '';
  let createdAt = Date.now();
  const startedAt = Date.now();
  let deadlineExceeded = false;
  const deadline = setTimeout(() => {
    deadlineExceeded = true;
    aborter.abort(new Error('Generation deadline exceeded.'));
  }, options.deadlineMs ?? CHAT_GENERATION_DEADLINE_MS);
  const aborter = new AbortController();
  const onAbort = () => aborter.abort(options.signal.reason);
  if (options.signal.aborted) {
    onAbort();
  } else {
    options.signal.addEventListener('abort', onAbort, { once: true });
  }
  const cleanup = (outcome: 'completed' | 'failed' | 'cancelled') => {
    if (terminalOutcome !== null) {
      return;
    }
    terminalOutcome = outcome;
    clearTimeout(deadline);
    options.signal.removeEventListener('abort', onAbort);
    options.onTerminal?.(outcome, Date.now() - startedAt);
  };
  let releaseStarted = false;
  const releaseFailedAttempt = async (state: 'failed' | 'cancelled') => {
    if (releaseStarted || terminalOutcome !== null) {
      return;
    }
    releaseStarted = true;
    try {
      await options.failGeneration?.(state);
    } catch (_error) {}
    cleanup(state === 'cancelled' ? 'cancelled' : 'failed');
  };
  let terminalOutcome: 'completed' | 'failed' | 'cancelled' | null = null;

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

  const abortEvent = (): ChatStreamEvent =>
    deadlineExceeded
      ? {
          type: 'error',
          code: 'deadline_exceeded',
          message: 'The generation deadline elapsed.',
        }
      : { type: 'error', code: 'aborted', message: 'The request was cancelled.' };

  const completeTurn = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> => {
    if (aborter.signal.aborted) {
      await releaseFailedAttempt(deadlineExceeded ? 'failed' : 'cancelled');
      finish(controller, abortEvent());
      return;
    }
    let stored: Message | null;
    try {
      stored = await options.persistAssistantReply(collected, options.replyId, createdAt);
    } catch {
      await releaseFailedAttempt('failed');
      finish(controller, {
        type: 'error',
        code: 'persistence_failed',
        message:
          'The reply was generated but could not be saved. Retry with the same message id to recover its status.',
      });
      return;
    }
    if (stored === null) {
      await releaseFailedAttempt('failed');
      finish(controller, {
        type: 'error',
        code: 'not_persisted',
        message: 'The reply could not be saved.',
      });
      return;
    }
    cleanup('completed');
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

        if (aborter.signal.aborted) {
          done = true;
          await releaseFailedAttempt(deadlineExceeded ? 'failed' : 'cancelled');
          finish(controller, abortEvent());
          return;
        }

        if (exhausted) {
          done = true;
          await completeTurn(controller);
          return;
        }

        iterator ??= options.model.generate(options.prompt, aborter.signal)[Symbol.asyncIterator]();

        const next = await iterator.next();

        if (done) {
          return;
        }
        if (aborter.signal.aborted) {
          done = true;
          await releaseFailedAttempt(deadlineExceeded ? 'failed' : 'cancelled');
          finish(controller, abortEvent());
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
        if (
          new TextEncoder().encode(collected).byteLength >
          (options.maxOutputBytes ?? CHAT_OUTPUT_MAX_BYTES)
        ) {
          done = true;
          await releaseFailedAttempt('failed');
          finish(controller, {
            type: 'error',
            code: 'output_limit',
            message: 'The reply exceeded the configured output byte limit.',
          });
          void iterator.return?.();
          return;
        }
        emit(controller, { type: 'delta', text: next.value.text });
      } catch (error) {
        done = true;
        await releaseFailedAttempt(
          aborter.signal.aborted && !deadlineExceeded ? 'cancelled' : 'failed',
        );
        let failureCode = 'model_failed';
        if (aborter.signal.aborted) {
          failureCode = deadlineExceeded ? 'deadline_exceeded' : 'aborted';
        }
        let failureMessage = 'The model failed.';
        if (aborter.signal.aborted) {
          failureMessage = deadlineExceeded
            ? 'The generation deadline elapsed.'
            : 'The request was cancelled.';
        } else if (error instanceof Error) {
          failureMessage = error.message.slice(0, 512);
        }
        finish(controller, {
          type: 'error',
          code: failureCode,
          message: failureMessage,
        });
      }
    },
    async cancel() {
      // The browser went away. Marking the turn done is what stops the next `pull`
      // from enqueuing into a cancelled stream, and releasing the iterator stops the
      // model generating tokens nobody will read.
      done = true;
      aborter.abort(new Error('Response reader cancelled.'));
      await releaseFailedAttempt('cancelled');
      void iterator?.return?.();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
};

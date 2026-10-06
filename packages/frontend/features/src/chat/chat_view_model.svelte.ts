// packages/frontend/features/src/chat/chat_view_model.svelte.ts
//
// Screen state for a conversation: the list of messages, the in-flight turn, and
// the queue that holds what could not be sent yet.
//
// Three states have to be represented, and the mistake this file exists to avoid is
// trying to do it with booleans:
//
//   1. **Sending.** The user's message is on screen before the server has it. It is
//      marked `pending` so the UI can render it differently and so a failure has
//      something to roll back.
//   2. **Streaming.** The server stored the message and is producing a reply. The
//      reply is on screen as `streaming`, appended chunk by chunk.
//   3. **Queued.** The message is not on the server and cannot be sent right now —
//      no conversation yet, or the last attempt failed. It stays in the queue and is
//      retried by `flush()`.
//
// So `messages` carries a per-message state, and `pending`/`streaming` are derived
// from it rather than stored beside it. Two independent fields would admit the
// state where a message is both pending and streaming, which is the state nobody
// handles.
//
// **Why a queue rather than a retry counter.** A user on a train writes three
// messages, loses signal, and comes back. With a retry counter the ViewModel either
// retries all three (and may send a third copy of one) or gives up silently. A queue
// holds the *messages*, each with the client id the server will dedupe on, so
// flushing after reconnecting sends exactly what was written.

import type { Conversation, Message, MessageRole } from '@starter/schemas/chat';
import { disposeScreen, type ScreenGuards, type ScreenOwner } from '@starter/ui/screen';
import { createClientId, MutationGuard, StaleGuard, toAppError } from '@starter/utils';
import type { ChatService, ChatStreamUpdate, StreamTurnResult } from './chat_service.svelte.ts';

/**
 * A message as this screen holds it.
 *
 * `id` is the *client's* id for an optimistic message and the server's for a stored
 * one, which is why `clientId` is carried separately: the server row's id is not
 * known until the `user-message` frame arrives, and matching by position instead
 * would swap one message for another whenever two were written in the same
 * millisecond.
 */
export interface ChatMessageView {
  /** The client id, stable from render to send. The reconciliation key. */
  readonly clientId: string;
  /** The server's id once known, else `null`. */
  readonly serverId: string | null;
  readonly role: MessageRole;
  readonly content: string;
  /** `pending` before the server has it, `streaming` mid-reply, else `failed`/`sent`. */
  readonly state: 'pending' | 'sent' | 'streaming' | 'failed';
  readonly createdAt: number;
}

export type ChatStatus =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string; retryable: boolean };

export interface ChatScreenOptions {
  readonly chat: ChatService;
  /** The conversation this screen shows, or `null` before one exists. */
  readonly conversation: Conversation | null;
  /** The history the server already rendered, so the first paint is not empty. */
  readonly initialMessages?: readonly Message[];
  /**
   * Injected so a test drives real frames rather than a model of them.
   *
   * Defaults to `createClientId`, and the injection point is deliberate: the queue's
   * correctness depends on two sends in the same millisecond getting *different*
   * ids, which is a property of the generator and not of this class.
   */
  readonly newClientId?: () => string;
}

/** One failed send, held for a retry. */
interface QueuedMessage {
  readonly clientId: string;
  readonly content: string;
  /** Why the last attempt failed, shown next to the queued message. */
  readonly failure: string | null;
}

export class ChatViewModel implements ScreenOwner, ScreenGuards {
  readonly className = 'ChatViewModel';

  status = $state<ChatStatus>({ kind: 'loading' });
  messages = $state<ChatMessageView[]>([]);
  /** Queued messages, oldest first. Rendered below the transcript. */
  queue = $state<QueuedMessage[]>([]);
  /** The composer draft. */
  draft = $state('');

  /** Claimed by `ScreenContainer`; never written from here. */
  mounted = false;

  readonly requests = new StaleGuard();
  readonly mutations = new MutationGuard();

  readonly #chat: ChatService;
  readonly #newClientId: () => string;

  #conversation: Conversation | null;
  #seeded = false;
  /** The in-flight turn's abort controller, or `null` when nothing is streaming. */
  #turn: AbortController | null = null;

  constructor(options: ChatScreenOptions) {
    this.#chat = options.chat;
    this.#conversation = options.conversation;
    this.#newClientId = options.newClientId ?? createClientId;
    if (options.initialMessages !== undefined) {
      this.seed(options.initialMessages);
    }
  }

  get conversation(): Conversation | null {
    return this.#conversation;
  }

  get conversationId(): string | null {
    return this.#conversation?.id ?? null;
  }

  /** True while a reply is being produced. One turn at a time, by design. */
  get isStreaming(): boolean {
    return this.#turn !== null;
  }

  get isBusy(): boolean {
    return this.mutations.busy || this.isStreaming;
  }

  /** Messages the user can see: the transcript, newest last. */
  get transcript(): ChatMessageView[] {
    return this.messages;
  }

  get hasQueue(): boolean {
    return this.queue.length > 0;
  }

  /** True when the composer has text worth sending. */
  get canSend(): boolean {
    return this.draft.trim().length > 0 && !this.isStreaming;
  }

  /**
   * Replace the transcript with one the server already sent.
   *
   * Any queue is cleared, and that is worth stating: the queue holds messages the
   * server has never seen, and replacing the transcript with the server's view while
   * keeping them would show the user two different conversations — the one that
   * exists and the one they are typing into.
   */
  seed(messages: readonly Message[]): void {
    this.messages = messages.map((message) => toView(message));
    this.queue = [];
    this.status = { kind: 'ready' };
    this.#seeded = true;
  }

  async initialize(): Promise<void> {
    if (this.#seeded) {
      return;
    }
    await this.reload();
  }

  /** Re-read the history, discarding the answer if a newer read started. */
  async reload(): Promise<void> {
    const conversationId = this.conversationId;
    if (conversationId === null || this.requests.cancelled) {
      // No conversation yet: there is nothing to read, and calling this would be a
      // request to `/api/chat/conversations/undefined/messages`.
      this.status = { kind: 'ready' };
      return;
    }

    const { token, signal } = this.requests.begin();
    this.status = { kind: 'loading' };

    try {
      const messages = await this.#chat.listMessages(conversationId, signal);
      if (!this.requests.isCurrent(token)) {
        return;
      }
      this.messages = messages.map((message) => toView(message));
      this.status = { kind: 'ready' };
    } catch (error) {
      if (!this.requests.isCurrent(token)) {
        return;
      }
      const appError = toAppError(error, 'Could not load the conversation.');
      if (appError.errorType === 'aborted') {
        return;
      }
      this.status = {
        kind: 'error',
        message: appError.message,
        retryable: appError.errorType !== 'forbidden' && appError.errorType !== 'unauthorized',
      };
    }
  }

  setDraft(value: string): void {
    this.draft = value;
  }

  /**
   * Send whatever is in the composer.
   *
   * Appends the message locally *before* the request, marked `pending`. The message
   * is on screen the instant the user pressed send, which is the whole point of an
   * optimistic write — and the `pending` state is what makes the rollback below
   * findable.
   *
   * A second send while a turn is streaming is refused. Two turns in one
   * conversation produce two replies whose chunks interleave in the transcript, and
   * the result reads as a single incoherent answer.
   */
  async send(): Promise<boolean> {
    const content = this.draft.trim();
    if (content.length === 0 || this.isStreaming) {
      return false;
    }

    this.draft = '';
    const clientId = this.#newClientId();
    this.#appendOptimistic({ clientId, role: 'user', content, state: 'pending' });
    this.#turn = new AbortController();

    return this.#attempt(clientId, content, this.#turn.signal);
  }

  /**
   * Retry everything queued, in the order it was written.
   *
   * Sequential rather than concurrent, and that is a correctness decision rather
   * than a performance one: two concurrent sends can arrive out of order, and a
   * transcript whose messages are ordered by arrival rather than by when the user
   * wrote them reads as a conversation that was not had.
   */
  async flush(): Promise<void> {
    const conversationId = this.conversationId;
    if (conversationId === null || this.queue.length === 0 || this.isStreaming) {
      return;
    }

    // Taken once: the queue shrinks as each send succeeds, and re-reading it each
    // iteration would skip or repeat entries.
    const pending = [...this.queue];
    for (const entry of pending) {
      this.#dequeue(entry.clientId);

      // Each retry is a fresh optimistic row, because the queued entry has no row on
      // screen — it was removed when the send failed, since a message the server
      // never received is one the transcript should not claim to hold.
      this.#appendOptimistic({
        clientId: entry.clientId,
        role: 'user',
        content: entry.content,
        state: 'pending',
      });

      const controller = new AbortController();
      this.#turn = controller;
      const sent = await this.#attempt(entry.clientId, entry.content, controller.signal);
      if (!sent) {
        // Re-queued with the new reason. Stopping is deliberate: the failure that
        // stopped it will probably stop the next one, and retrying into the same
        // wall is how a queue turns into a hot loop.
        this.#enqueue(entry.clientId, entry.content, 'The message could not be sent.');
        return;
      }
    }
  }

  /** Discard a queued message the user no longer wants to send. */
  discard(clientId: string): void {
    this.#dequeue(clientId);
    this.messages = this.messages.filter((message) => message.clientId !== clientId);
  }

  /**
   * Cancel the turn in flight.
   *
   * Aborting stops the model generating tokens, which the Worker half honours. The
   * half-written reply is left on screen as `failed` rather than removed: the user
   * read some of it, and deleting text someone has already read is worse than
   * marking it incomplete.
   */
  cancelTurn(): void {
    this.#turn?.abort();
    this.#turn = null;
    this.#markStreamingFailed();
  }

  async dispose(): Promise<void> {
    this.#turn?.abort();
    this.#turn = null;
    await disposeScreen(this);
  }

  // ---------------------------------------------------------------------------
  // The one send path
  // ---------------------------------------------------------------------------

  /**
   * Attempt one send, and reconcile however it ended.
   *
   * The four outcomes, and why each does what it does:
   *
   *   - **sent**: `user-message` arrived, so replace the optimistic row by
   *     `clientId` with the server's row, then stream the reply.
   *   - **reply streamed**: the transcript now holds the stored reply. Mark it sent.
   *   - **turn failed**: keep the user's message, mark the reply `failed`. It was
   *     delivered — re-sending would deliver it twice.
   *   - **send failed**: the user's message never reached the server, so move it
   *     into the queue. Rolling it back and removing it would lose what the user
   *     typed on a bad connection, which is the case the queue exists for.
   */
  async #attempt(clientId: string, content: string, signal: AbortSignal): Promise<boolean> {
    const conversationId = this.conversationId;
    if (conversationId === null) {
      // No conversation. Queued rather than dropped: the user wrote it before there
      // was anywhere to put it, and the next `flush` will send it.
      this.#enqueue(clientId, content, 'There is no conversation yet.');
      return false;
    }

    // One `MutationGuard` for the whole turn, held across the send *and* the
    // reply: the turn is one unit of work, and two overlapping turns in one
    // conversation interleave their replies in the transcript.
    const handle = this.mutations.begin();
    if (handle === null) {
      this.#turn = null;
      this.#enqueue(clientId, content, 'The screen was closed.');
      return false;
    }

    // The turn's own abort controller and the mutation guard's signal are combined
    // so that *either* ends the stream: the user cancelling, and the screen being
    // torn down, are different events with the same consequence for the model.
    const combined = AbortSignal.any([handle.signal, signal]);

    try {
      const result = await this.#chat.streamTurn(conversationId, { content, clientId }, combined);

      if (this.mutations.disposed) {
        // The screen was torn down mid-turn. The message is queued because nothing
        // proves the server stored it, and re-sending is safe: `clientId` is the
        // idempotency key, so a duplicate submission returns the same row.
        this.#enqueue(clientId, content, 'The screen was closed.');
        return false;
      }

      this.#reconcile(result);
      // False when the turn ended in an `error` frame: the caller's message was
      // delivered, so it must not be queued for a resend, but the turn did not
      // succeed and the caller is entitled to know that.
      return result.failure === undefined;
    } catch (error) {
      const appError = toAppError(error, 'Could not send the message.');
      if (appError.errorType === 'aborted') {
        // Not proof of failure either way. The message is marked failed and left in
        // place, because re-sending here could duplicate a turn the server did
        // store; the next reload reconciles against what it actually holds.
        this.#markPending(clientId);
        return false;
      }
      this.#enqueue(clientId, content, appError.message);
      this.#removeOptimistic(clientId);
      return false;
    } finally {
      // Cleared on every path, including the ones that return early above: leaving
      // it set would make `isStreaming` permanently true and block every later send.
      this.#turn = null;
      this.mutations.end();
    }
  }

  /** Apply a completed stream to the transcript. */
  #reconcile(result: StreamTurnResult): void {
    for (const update of result.events) {
      this.#applyUpdate(update);
    }

    if (result.failure !== undefined) {
      this.#markStreamingFailed();
    } else {
      this.#markStreamingSent(result.message);
    }

    // The turn is over either way; the flag is what stops `cancelTurn` from
    // aborting a stream that has already finished.
    this.#turn = null;
  }

  #applyUpdate(update: ChatStreamUpdate): void {
    if (update.userMessage !== undefined) {
      // Matched on the client id the caller sent, which the `user-message` frame
      // echoes. Not on the server id: the optimistic row does not have one yet,
      // and matching by position would swap one message for another whenever two
      // were written in the same millisecond.
      const stored = update.userMessage;
      this.messages = this.messages.map((message) =>
        message.serverId === null && message.state === 'pending'
          ? { ...toView(stored, message.clientId) }
          : message,
      );
      return;
    }

    if (update.replyId !== undefined) {
      // The reply is announced before any of its text. Creating the row here is
      // what makes the UI show a streaming placeholder rather than nothing at all
      // between the user's message and the first chunk.
      this.messages = [
        ...this.messages,
        {
          clientId: `stream:${update.replyId}`,
          serverId: update.replyId,
          role: 'assistant',
          content: '',
          state: 'streaming',
          createdAt: Date.now(),
        },
      ];
      return;
    }

    if (update.delta !== undefined) {
      this.messages = this.messages.map((message) =>
        message.state === 'streaming'
          ? { ...message, content: message.content + update.delta }
          : message,
      );
      return;
    }

    if (update.complete !== undefined) {
      this.messages = this.messages.map((message) =>
        message.serverId === update.complete?.id
          ? { ...message, content: update.complete?.content ?? message.content, state: 'sent' }
          : message,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Transcript bookkeeping
  // ---------------------------------------------------------------------------

  #appendOptimistic(input: {
    clientId: string;
    role: MessageRole;
    content: string;
    state: ChatMessageView['state'];
  }): void {
    this.messages = [
      ...this.messages,
      {
        clientId: input.clientId,
        serverId: null,
        role: input.role,
        content: input.content,
        state: input.state,
        createdAt: Date.now(),
      },
    ];
  }

  #removeOptimistic(clientId: string): void {
    this.messages = this.messages.filter((message) => message.clientId !== clientId);
  }

  /** Mark one optimistic message as not delivered. Its text stays on screen. */
  #markPending(clientId: string): void {
    this.messages = this.messages.map((message) =>
      message.clientId === clientId ? { ...message, state: 'failed' } : message,
    );
  }

  /**
   * Mark the half-written reply as incomplete.
   *
   * The text is kept rather than discarded: the user read some of it, and deleting
   * text someone has already seen is worse than marking it unfinished.
   */
  #markStreamingFailed(): void {
    this.messages = this.messages.map((message) =>
      message.state === 'streaming' ? { ...message, state: 'failed' } : message,
    );
  }

  #markStreamingSent(message: Message | undefined): void {
    if (message === undefined) {
      this.messages = this.messages.map((entry) =>
        entry.state === 'streaming' ? { ...entry, state: 'sent' } : entry,
      );
      return;
    }
    this.messages = this.messages.map((entry) =>
      entry.state === 'streaming'
        ? { ...entry, serverId: message.id, content: message.content, state: 'sent' }
        : entry,
    );
  }

  #enqueue(clientId: string, content: string, failure: string): void {
    if (this.queue.some((entry) => entry.clientId === clientId)) {
      return;
    }
    this.queue = [...this.queue, { clientId, content, failure }];
  }

  #dequeue(clientId: string): void {
    this.queue = this.queue.filter((entry) => entry.clientId !== clientId);
  }
}

/**
 * A stored row, as this screen holds it.
 *
 * `clientId` is a parameter because an optimistic row and a stored one share a
 * shape but not an identity: the optimistic row is keyed on the id the *caller*
 * generated, and it is replaced in place when the server's row arrives. Keying the
 * replacement on the server id instead would leave every optimistic row orphaned the
 * moment it was reconciled.
 */
const toView = (message: Message, clientId?: string): ChatMessageView => ({
  clientId: clientId ?? message.id,
  serverId: message.id,
  role: message.role,
  content: message.content,
  state: 'sent',
  createdAt: message.createdAt,
});

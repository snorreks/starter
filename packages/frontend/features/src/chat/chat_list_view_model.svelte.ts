// packages/frontend/features/src/chat/chat_list_view_model.svelte.ts
//
// Screen state for the conversation list: what exists, and creating another.
//
// "Creating a conversation" is a mutation, and this repository has one mutation
// path: `/api/*`. So this is a ViewModel that posts to the API like every other one,
// *not* a SvelteKit form action. The navigation afterwards is raised as an intent
// through the injected `Navigation` capability, which is the same seam every other
// screen uses and the reason this class can be tested without a router.

import type { Navigation } from '@starter/platform';
import type { Conversation, ConversationCreate } from '@starter/schemas/chat';
import { AsyncOperation } from '@starter/ui/async_operation.svelte';
import {
  disposeScreen,
  type ScreenGuards,
  type ScreenOwner,
  ScreenScope,
} from '@starter/ui/screen';
import { toAppError } from '@starter/utils';
import type { ChatService } from './chat_service.ts';

type ChatListService = Pick<ChatService, 'listConversations' | 'createConversation'>;

export type ChatListStatus =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string; retryable: boolean };

export type CreateConversationResult =
  | { kind: 'created'; conversation: Conversation }
  | { kind: 'created-navigation-failed'; conversation: Conversation; message: string }
  | { kind: 'rejected'; message: string }
  | { kind: 'unknown-outcome'; message: string };

export interface ChatListScreenOptions {
  readonly chat: ChatListService;
  /** How this host moves between screens. */
  readonly navigation: Navigation;
  /** The list the server already rendered, so the first paint is not empty. */
  readonly initialConversations?: readonly Conversation[];
}

export class ChatListViewModel implements ScreenOwner, ScreenGuards {
  readonly className = 'ChatListViewModel';

  status = $state<ChatListStatus>({ kind: 'loading' });
  conversations = $state<Conversation[]>([]);
  /** The new-conversation title being typed. */
  draftTitle = $state('');
  /** Why the last create attempt failed, or `null`. */
  createError = $state<string | null>(null);

  /** Claimed by `ScreenContainer`; never written from here. */
  mounted = false;

  readonly scope = new ScreenScope();
  get requests() {
    return this.scope.requests;
  }
  get mutations() {
    return this.scope.mutations;
  }
  readonly operation = new AsyncOperation();

  readonly #chat: ChatListService;
  readonly #navigation: Navigation;
  #seeded = false;
  #localCreates = new Map<string, Conversation>();

  constructor(options: ChatListScreenOptions) {
    this.#chat = options.chat;
    this.#navigation = options.navigation;
    if (options.initialConversations !== undefined) {
      this.seed(options.initialConversations);
    }
  }

  get isEmpty(): boolean {
    return this.status.kind === 'ready' && this.conversations.length === 0;
  }

  get isCreating(): boolean {
    return this.operation.isPending;
  }

  get canCreate(): boolean {
    return this.draftTitle.trim().length > 0 && !this.isCreating;
  }

  seed(conversations: readonly Conversation[]): void {
    this.requests.invalidate();
    const received = new Set(conversations.map(({ id }) => id));
    for (const id of received) {
      this.#localCreates.delete(id);
    }
    this.conversations = [
      ...conversations,
      ...[...this.#localCreates.values()].filter(({ id }) => !received.has(id)),
    ];
    this.status = { kind: 'ready' };
    this.#seeded = true;
  }

  async initialize(): Promise<void> {
    if (this.#seeded) {
      return;
    }
    await this.load();
  }

  async load(): Promise<void> {
    if (this.requests.cancelled) {
      return;
    }

    const { token, signal } = this.requests.begin();
    this.status = { kind: 'loading' };

    try {
      const conversations = await this.#chat.listConversations(signal);
      if (!this.requests.isCurrent(token)) {
        return;
      }
      const received = new Set(conversations.map(({ id }) => id));
      for (const id of received) {
        this.#localCreates.delete(id);
      }
      this.conversations = [
        ...conversations,
        ...[...this.#localCreates.values()].filter(({ id }) => !received.has(id)),
      ];
      this.status = { kind: 'ready' };
    } catch (error) {
      if (!this.requests.isCurrent(token)) {
        return;
      }
      const appError = toAppError(error, 'Could not load your conversations.');
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

  setDraftTitle(value: string): void {
    this.draftTitle = value;
    this.createError = null;
  }

  /**
   * Create, then navigate to it.
   *
   * The navigation is a separate step from the write rather than part of it, so a
   * create that succeeded and a navigation that failed are different outcomes. On a
   * failure the new conversation *is* on the server, so it is pushed onto the list
   * and the user is told to retry the navigation — reporting "could not create"
   * would be a lie about state that exists.
   */
  async create(): Promise<CreateConversationResult> {
    const title = this.draftTitle.trim();
    if (title.length === 0 || this.mutations.disposed || this.isCreating) {
      return { kind: 'rejected', message: 'A conversation cannot be created right now.' };
    }

    const handle = this.mutations.begin();
    if (handle === null) {
      return { kind: 'rejected', message: 'A conversation cannot be created right now.' };
    }

    this.createError = null;
    try {
      const created = await this.operation.run(
        () => this.#chat.createConversation({ title } as ConversationCreate, handle.signal),
        { singleFlight: true },
      );
      if (created === undefined) {
        return { kind: 'rejected', message: 'Creation is already in progress.' };
      }
      if (this.mutations.disposed) {
        return { kind: 'unknown-outcome', message: 'The result arrived after this screen closed.' };
      }

      this.draftTitle = '';
      this.#localCreates.set(created.id, created);
      this.conversations = [created, ...this.conversations];
      try {
        await this.#navigation.go(`/chat/${encodeURIComponent(created.id)}`);
        return { kind: 'created', conversation: created };
      } catch {
        const message = 'Conversation created. Open it from the list to continue.';
        this.createError = message;
        return { kind: 'created-navigation-failed', conversation: created, message };
      }
    } catch (error) {
      const appError = toAppError(error, 'Could not create the conversation.');
      if (!this.mutations.disposed) {
        this.createError = appError.message;
      }
      return appError.errorType === 'network' || appError.errorType === 'aborted'
        ? { kind: 'unknown-outcome', message: appError.message }
        : { kind: 'rejected', message: appError.message };
    } finally {
      this.mutations.end();
    }
  }

  /** Open an existing conversation. */
  async open(conversation: Conversation): Promise<void> {
    await this.#navigation.go(`/chat/${encodeURIComponent(conversation.id)}`);
  }

  async dispose(): Promise<void> {
    this.operation.close();
    await disposeScreen(this);
  }
}

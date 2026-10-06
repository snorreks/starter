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
import { disposeScreen, type ScreenGuards, type ScreenOwner } from '@starter/ui/screen';
import { MutationGuard, StaleGuard, toAppError } from '@starter/utils';
import type { ChatService } from './chat_service.svelte.ts';

export type ChatListStatus =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string; retryable: boolean };

export interface ChatListScreenOptions {
  readonly chat: ChatService;
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

  readonly requests = new StaleGuard();
  readonly mutations = new MutationGuard();

  readonly #chat: ChatService;
  readonly #navigation: Navigation;
  #seeded = false;
  #inFlight = $state(0);

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
    return this.#inFlight > 0;
  }

  get canCreate(): boolean {
    return this.draftTitle.trim().length > 0 && !this.isCreating;
  }

  seed(conversations: readonly Conversation[]): void {
    this.conversations = [...conversations];
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
      this.conversations = conversations;
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
  async create(): Promise<boolean> {
    const title = this.draftTitle.trim();
    if (title.length === 0 || this.mutations.disposed) {
      return false;
    }

    const handle = this.mutations.begin();
    if (handle === null) {
      return false;
    }

    this.#inFlight += 1;
    this.createError = null;
    try {
      const created = await this.#chat.createConversation(
        { title } as ConversationCreate,
        handle.signal,
      );
      if (this.mutations.disposed) {
        return false;
      }

      this.draftTitle = '';
      this.conversations = [created, ...this.conversations];
      await this.#navigation.go(`/chat/${encodeURIComponent(created.id)}`);
      return true;
    } catch (error) {
      const appError = toAppError(error, 'Could not create the conversation.');
      if (appError.errorType === 'aborted') {
        return false;
      }
      this.createError = appError.message;
      return false;
    } finally {
      this.#inFlight -= 1;
      this.mutations.end();
    }
  }

  /** Open an existing conversation. */
  async open(conversation: Conversation): Promise<void> {
    await this.#navigation.go(`/chat/${encodeURIComponent(conversation.id)}`);
  }

  async dispose(): Promise<void> {
    await disposeScreen(this);
  }
}

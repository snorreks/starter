// packages/frontend/features/src/chat/chat_list_view_model.svelte.ts
//
// Screen state for the conversation list: what exists, and creating another.
//
// "Creating a conversation" is a mutation, and this repository has one mutation
// path: `/api/*`. So this is a ViewModel that posts to the API like every other one,
// *not* a SvelteKit form action. The navigation afterwards is raised as an intent
// through the injected `Navigation` capability, which is the same seam every other
// screen uses and the reason this class can be tested without a router.

import type { LiveMode, LiveSubscription, LiveUpdates } from '@starter/live';
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
import { fingerprint } from './fingerprint.ts';

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
  /**
   * How this screen learns its list changed. Injected, never found — the same rule
   * as `navigation`, and for the same reason.
   */
  readonly live?: LiveUpdates;
}

/**
 * The topic a signed-in user's conversation list moves on.
 *
 * Deliberately not per-user: a topic names *what changed*, not *whose*. The
 * transport authorizes each subscriber against its own verified identity when it
 * attaches, so one shared topic cannot become a channel through which a user reads
 * another's list. Naming it per-user here would suggest the topic is what carries
 * identity, and it is not.
 */
const CONVERSATIONS_TOPIC = 'conversations';

/**
 * What the server's conversation list currently amounts to.
 *
 * Title and count, because those are the two fields the list renders and the two
 * that move when a turn happens: a conversation that gained a reply has a higher
 * `messageCount` and a newer `updated_at`, which is also what reorders the list.
 * Hashing only the ids would miss every one of those.
 */
const conversationFingerprint = (rows: readonly Conversation[]): string =>
  fingerprint(rows.map((row) => ({ id: row.id, content: `${row.title}:${row.messageCount}` })));

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
  readonly #live: LiveUpdates | undefined;
  #liveSubscription: LiveSubscription | null = null;
  #seeded = false;
  #localCreates = new Map<string, Conversation>();

  constructor(options: ChatListScreenOptions) {
    this.#chat = options.chat;
    this.#navigation = options.navigation;
    this.#live = options.live;
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
    this.#merge(conversations);
    this.#seeded = true;
  }

  /**
   * Fold a server list into what this screen holds.
   *
   * Shared by the SSR seed, an explicit `load()` and a background pull, because
   * the local-create reconciliation is a correctness rule and three copies of it
   * would be three chances to forget it: a conversation created in this tab stays
   * on screen until the server's own copy of it arrives, and dropping it for the
   * duration of a poll would make a just-created conversation blink out of the
   * list it was added to.
   */
  #merge(conversations: readonly Conversation[]): void {
    const received = new Set(conversations.map(({ id }) => id));
    for (const id of received) {
      this.#localCreates.delete(id);
    }
    this.conversations = [
      ...conversations,
      ...[...this.#localCreates.values()].filter(({ id }) => !received.has(id)),
    ];
    this.status = { kind: 'ready' };
  }

  async initialize(): Promise<void> {
    this.#watch();
    if (this.#seeded) {
      return;
    }
    await this.load();
  }

  /**
   * How this screen is currently learning about change.
   *
   * `'disabled'` when no liveness source was injected, which is the honest
   * position for a host that has not adopted live updates.
   */
  get liveMode(): LiveMode {
    return this.#live?.mode ?? 'disabled';
  }

  /**
   * Re-read now, because the host says this window just became visible.
   *
   * The host owns that fact. A window that was hidden missed every notification it
   * would have been sent, so its list is behind by an unbounded amount.
   */
  refreshNow(): void {
    this.#watch();
    this.#live?.refresh();
  }

  #watch(): void {
    if (this.#live === undefined || this.#liveSubscription !== null) {
      return;
    }
    this.#liveSubscription = this.#live.subscribe(CONVERSATIONS_TOPIC, () => {
      void this.#pullLatest();
    });
  }

  /**
   * Re-read in the background because something said the list moved.
   *
   * Silent on failure, for the reason `ChatViewModel.#pullLatest` gives: a poll
   * that failed leaves the list exactly as correct — and as stale — as it was, and
   * replacing a readable list with an error because a poll timed out would be a
   * worse screen than the one it replaced.
   */
  async #pullLatest(): Promise<void> {
    if (this.requests.cancelled || this.isCreating || this.#liveSubscription === null) {
      return;
    }
    const before = this.#fingerprint();
    const { token, signal } = this.requests.begin();
    try {
      const conversations = await this.#chat.listConversations(signal);
      if (!this.requests.isCurrent(token)) {
        return;
      }
      if (conversationFingerprint(conversations) !== before) {
        // Collapses a polling transport's backoff; see the note in ChatViewModel.
        this.#liveSubscription.notifyChanged();
      }
      this.#merge(conversations);
    } catch {
      /* a failed background read leaves the screen as it was */
    }
  }

  /** What the server's list currently amounts to, for change detection. */
  #fingerprint(): string {
    return conversationFingerprint(
      this.conversations.filter((conversation) => !this.#localCreates.has(conversation.id)),
    );
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
      this.#merge(conversations);
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
    // Before `disposeScreen`, so a notification arriving during teardown finds a
    // closed subscription rather than a live one writing into disposed state.
    this.#liveSubscription?.close();
    this.#liveSubscription = null;
    this.operation.close();
    await disposeScreen(this);
  }
}

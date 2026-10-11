// apps/frontend/client/src/lib/composition/chat.ts
//
// The web application's chat wiring.
//
// Same shape as `notes.ts` and for the same reason: a service needs a transport, and
// which transport a host has is the host's decision. A route imports from here,
// never from the feature package's defaults.
//
// Each ViewModel supplies its own per-turn update callback, so the shared service
// can stream into the active screen without retaining a ViewModel between calls.

import { ChatListViewModel, ChatService, ChatViewModel } from '@starter/features/chat';
import { createPollingLiveUpdates, type LiveUpdates } from '@starter/live';
import type { Navigation } from '@starter/platform';
import type { Conversation, Message } from '@starter/schemas/chat';
import { webTransport } from './transport.ts';

export interface ChatComposition {
  chat?: ChatService;
  /** The conversation this screen shows, or `null` before one exists. */
  conversation?: Conversation | null;
  /** The history the SSR load already produced, so the first paint is not empty. */
  initialMessages?: readonly Message[];
  olderCursor?: string | null;
  hasOlder?: boolean;
  /** Injected so a test drives deterministic client ids. */
  newClientId?: () => string;
  /** How this host learns the conversation changed. Defaults to this host's transport. */
  live?: LiveUpdates;
}

/**
 * One service for the application.
 *
 * Stateless — the transcript lives in the ViewModel that owns the screen — so a
 * single instance cannot disagree with a second one.
 */
const chatService = new ChatService({ transport: webTransport });

/**
 * How this host learns a conversation changed.
 *
 * Polling, and deliberately the only transport constructed here: the WebSocket
 * hub is not built yet, and wiring the socket path now would mean shipping a
 * feature flag whose off-branch nobody had exercised. When it lands it becomes a
 * second implementation of the same interface chosen by configuration, and nothing
 * above this file changes.
 *
 * Two host facts are injected rather than reached for:
 *
 *   - `isActive` reads `document.visibilityState`, which does not exist during SSR.
 *     It is called only when a delay is scheduled, and scheduling happens from a
 *     subscription, which happens in `initialize()` — after mount. A poll armed
 *     during server rendering would be a timer on a screen nobody is looking at.
 *   - The bounds are left at the package defaults. They are the package's
 *     opinion, and a host that wants different ones passes them here rather than
 *     the package growing per-host constants.
 *
 * One shared instance: backoff and tick notifications span all subscribers. A
 * change reported by one screen resets polling for every screen, and a refresh
 * from one screen triggers rereads on the others as well.
 */
const liveUpdates: LiveUpdates = createPollingLiveUpdates({
  isActive: () => typeof document === 'undefined' || document.visibilityState === 'visible',
});

export const getChatService = (): ChatService => chatService;

export const getChatViewModel = (options: ChatComposition = {}): ChatViewModel =>
  new ChatViewModel({
    chat: options.chat ?? chatService,
    conversation: options.conversation ?? null,
    ...(options.initialMessages === undefined ? {} : { initialMessages: options.initialMessages }),
    ...(options.olderCursor === undefined ? {} : { olderCursor: options.olderCursor }),
    ...(options.hasOlder === undefined ? {} : { hasOlder: options.hasOlder }),
    ...(options.newClientId === undefined ? {} : { newClientId: options.newClientId }),
    live: options.live ?? liveUpdates,
  });

export interface ChatListComposition extends ChatComposition {
  /** How this host moves between screens. */
  navigation: Navigation;
  /** The list the SSR load already produced, so the first paint is not empty. */
  initialConversations?: readonly Conversation[];
}

/**
 * The list screen's ViewModel.
 *
 * Built here rather than at the route because it needs a `Navigation`, and which
 * navigation a host has is exactly the fact a composition root exists to decide.
 */
export const getChatListViewModel = (options: ChatListComposition): ChatListViewModel =>
  new ChatListViewModel({
    chat: options.chat ?? chatService,
    navigation: options.navigation,
    ...(options.initialConversations === undefined
      ? {}
      : { initialConversations: options.initialConversations }),
    live: options.live ?? liveUpdates,
  });

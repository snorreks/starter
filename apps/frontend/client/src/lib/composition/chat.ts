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
import type { Navigation } from '@starter/platform';
import type { Conversation, Message } from '@starter/schemas/chat';
import { webTransport } from './transport.ts';

export interface ChatComposition {
  chat?: ChatService;
  /** The conversation this screen shows, or `null` before one exists. */
  conversation?: Conversation | null;
  /** The history the SSR load already produced, so the first paint is not empty. */
  initialMessages?: readonly Message[];
  /** Injected so a test drives deterministic client ids. */
  newClientId?: () => string;
}

/**
 * One service for the application.
 *
 * Stateless — the transcript lives in the ViewModel that owns the screen — so a
 * single instance cannot disagree with a second one.
 */
const chatService = new ChatService({ transport: webTransport });

export const getChatService = (): ChatService => chatService;

export const getChatViewModel = (options: ChatComposition = {}): ChatViewModel =>
  new ChatViewModel({
    chat: options.chat ?? chatService,
    conversation: options.conversation ?? null,
    ...(options.initialMessages === undefined ? {} : { initialMessages: options.initialMessages }),
    ...(options.newClientId === undefined ? {} : { newClientId: options.newClientId }),
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
  });

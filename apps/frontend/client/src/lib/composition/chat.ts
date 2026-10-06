// apps/frontend/client/src/lib/composition/chat.ts
//
// The web application's chat wiring.
//
// Same shape as `notes.ts` and for the same reason: a service needs a transport, and
// which transport a host has is the host's decision. A route imports from here,
// never from the feature package's defaults.
//
// The one thing this file adds is the **stream callback**. `ChatService` takes an
// `onUpdate` so a caller can append a chunk as it arrives, and the browser's answer
// is "nothing" — the ViewModel reads the result and applies the updates itself.
//
// That is deliberate rather than an oversight. If the callback drove the ViewModel's
// state, a `ChatService` built for the browser would only work with one particular
// ViewModel, and the tests that inject a `fetch` would need a real ViewModel to
// observe anything. With the callback unset, the same service is the same object in
// the lane that drives a real `ReadableStream` and in the browser.

import type { Navigation } from '@starter/platform';
import { ChatListViewModel, ChatService, ChatViewModel } from '@starter/features/chat';
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
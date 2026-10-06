// packages/frontend/features/src/chat/index.ts
//
// The chat feature: a service that streams, screen state that queues, and two views.
//
// Subpath rather than the barrel, and for the reason every other feature here has
// one: the barrel pulls every schema into every graph that imports it, and chat is
// the largest set of schemas in the repository after jobs.

export { default as ChatComposer } from './chat_composer.svelte';
export { default as ChatListView } from './chat_list_view.svelte';
export {
  type ChatListScreenOptions,
  type ChatListStatus,
  ChatListViewModel,
} from './chat_list_view_model.svelte.ts';
export {
  ChatService,
  type ChatServiceOptions,
  type ChatStreamUpdate,
  readChatFrames,
  type StreamTurnResult,
} from './chat_service.svelte.ts';
export { default as ChatView } from './chat_view.svelte';
export {
  type ChatMessageView,
  type ChatScreenOptions,
  type ChatStatus,
  ChatViewModel,
} from './chat_view_model.svelte.ts';
<script lang="ts">
import { ChatView } from '@starter/features/chat';
import type { Conversation, Message } from '@starter/schemas/chat';
import { untrack } from 'svelte';
import { getChatViewModel } from '#lib/composition/chat.ts';

let {
  conversation,
  messages,
  olderCursor,
  hasOlder,
}: {
  conversation: Conversation;
  messages: Message[];
  olderCursor: string | null;
  hasOlder: boolean;
} = $props();

// The route keys this component by conversation ID. Refreshed snapshots merge by
// server identity; the ViewModel retains its drafts and queue during a live turn.
const viewModel = getChatViewModel({
  conversation: untrack(() => conversation),
  initialMessages: untrack(() => messages),
  olderCursor: untrack(() => olderCursor),
  hasOlder: untrack(() => hasOlder),
});

$effect(() => {
  const snapshot = messages;
  untrack(() => viewModel.reconcileServerSnapshot(snapshot));
});

// Visibility, through the window's own document — a host fact, so it lives here
// rather than in the ViewModel, for the same reason `Navigation` is injected.
// A tab that was hidden missed every notification it would have been sent, so its
// transcript is behind by an unbounded amount; this re-reads once on the way back
// rather than trusting whatever the held snapshot says.
//
// `refreshNow` is called unconditionally on the event rather than only on the
// transition into `visible`: a browser that fires the event while the document is
// still hidden has told us something changed and nothing would re-read for it.
$effect(() => {
  const onVisibility = (): void => viewModel.refreshNow();

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onVisibility);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onVisibility);
  };
});
</script>

<ChatView {viewModel} />

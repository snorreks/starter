<script lang="ts">
import { ChatView } from '@starter/features/chat';
import type { Conversation, Message } from '@starter/schemas/chat';
import { untrack } from 'svelte';
import { getChatViewModel } from '#lib/composition/chat.ts';
import { refreshOnReturn } from '#lib/composition/refresh_on_return.ts';

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
$effect(() => refreshOnReturn(() => viewModel.refreshNow(), document, window));
</script>

<ChatView {viewModel} />

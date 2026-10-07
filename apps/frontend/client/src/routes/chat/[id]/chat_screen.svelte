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
</script>

<ChatView {viewModel} />

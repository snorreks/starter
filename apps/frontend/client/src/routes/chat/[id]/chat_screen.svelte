<script lang="ts">
import { ChatView } from '@starter/features/chat';
import type { Conversation, Message } from '@starter/schemas/chat';
import { untrack } from 'svelte';
import { getChatViewModel } from '#lib/composition/chat.ts';

let { conversation, messages }: { conversation: Conversation; messages: Message[] } = $props();

// The route keys this component by conversation ID. Refreshed snapshots merge by
// server identity; the ViewModel retains its drafts and queue during a live turn.
const viewModel = getChatViewModel({
  conversation: untrack(() => conversation),
  initialMessages: untrack(() => messages),
});

$effect(() => {
  const snapshot = messages;
  untrack(() => viewModel.reconcileServerSnapshot(snapshot));
});
</script>

<ChatView {viewModel} />

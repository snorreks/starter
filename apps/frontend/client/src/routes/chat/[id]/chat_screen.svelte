<script lang="ts">
import { ChatView } from '@starter/features/chat';
import type { Conversation, Message } from '@starter/schemas/chat';
import { untrack } from 'svelte';
import { getChatViewModel } from '#lib/composition/chat.ts';

let { conversation, messages }: { conversation: Conversation; messages: Message[] } = $props();

// The route keys this component by conversation ID. Seed only when it mounts so
// unrelated page-data reloads preserve the draft, queue, and active reply.
const viewModel = getChatViewModel({
  conversation: untrack(() => conversation),
  initialMessages: untrack(() => messages),
});
</script>

<ChatView {viewModel} />

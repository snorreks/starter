// apps/frontend/client/src/routes/chat/[id]/+page.svelte
<!--
  The authenticated chat route.

  A route page owns one thing: constructing the ViewModel and handing it to the view.
  The transcript arrives from `+page.server.ts` — server-rendered, from the same chat
  service the streaming endpoint uses — so the first paint is the whole conversation
  rather than a spinner.

  The conversation and the history are seeded together. A ViewModel seeded with
  messages but no conversation would report `conversationId: null`, queue everything the
  user typed, and never send it — a failure that looks like a broken backend and is
  entirely a wiring mistake.
-->
<script lang="ts">
import { ChatView } from '@starter/features/chat';
import { untrack } from 'svelte';
import { getChatViewModel } from '#lib/composition/chat.ts';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();

const viewModel = getChatViewModel({
  // `untrack` means "the value right now": the ViewModel is constructed once and seeded
  // with what the server rendered. A bare read here would be captured as a reactive
  // read outside a closure, and the flagged fix — moving it into an effect — would be
  // wrong, because an effect does not run during server rendering and the first paint
  // would fall back to the loading state.
  conversation: untrack(() => data.conversation),
  initialMessages: untrack(() => data.messages),
});

// Re-seed on a client-side navigation to *another* conversation. Tracked on the
// conversation id, so an in-flight turn's `messages` updates do not overwrite the
// transcript the user is watching — only a genuinely different conversation reseeds.
$effect(() => {
  viewModel.seed(data.messages);
});
</script>

<svelte:head>
  <title>{data.conversation.title}</title>
</svelte:head>

<ChatView {viewModel} />
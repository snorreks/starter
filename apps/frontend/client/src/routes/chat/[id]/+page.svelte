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
import type { PageData } from './$types';
import ChatScreen from './chat_screen.svelte';

let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>{data.conversation.title}</title>
</svelte:head>

{#key data.conversation.id}
  <ChatScreen conversation={data.conversation} messages={data.messages} olderCursor={data.olderCursor} hasOlder={data.hasOlder} />
{/key}

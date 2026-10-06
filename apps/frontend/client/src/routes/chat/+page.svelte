<!--
  The conversation list.

  A route page owns one thing: constructing the ViewModel and handing it to the
  view. The list arrives from `+page.server.ts` — server-rendered, from the same chat
  service the API uses — so the first paint already has the data and the ViewModel is
  seeded rather than initialized empty.

  `navigation` is injected rather than imported by the feature: "go to this
  conversation" is a host capability, and a feature that reached for SvelteKit's
  router could only ever be run by this application.
-->
<script lang="ts">
import { ChatListView } from '@starter/features/chat';
import { untrack } from 'svelte';
import { getChatListViewModel } from '#lib/composition/chat.ts';
import { goto } from '$app/navigation';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();

const viewModel = getChatListViewModel({
  navigation: { go: (path: string) => goto(path) },
  // `untrack` means "the value right now": the ViewModel is constructed once and
  // seeded with what the server rendered. A bare read here would be captured as a
  // reactive read outside a closure, and the flagged fix — moving it into an effect —
  // would be wrong, because an effect does not run during server rendering and the
  // first paint would fall back to the loading state.
  initialConversations: untrack(() => data.conversations),
});

// Re-seed on a client-side navigation back to the list, so a conversation created in
// another tab shows up. Tracked on the array identity, so a refresh returning the same
// list does not churn the screen the reader is looking at.
$effect(() => {
  viewModel.seed(data.conversations);
});
</script>

<svelte:head>
  <title>Conversations</title>
</svelte:head>

<ChatListView {viewModel} />
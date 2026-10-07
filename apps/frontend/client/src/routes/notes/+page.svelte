<!--
  apps/frontend/client/src/routes/notes/+page.svelte

  The authenticated notes route.

  A route page owns exactly one thing: constructing the ViewModel and handing it to
  the view. The list arrives from `+page.server.ts` — server-rendered, from the same
  notes service the API endpoints use — so the first paint already has the data.

  Two consequences worth naming:

    * No session check dance. The load redirects an anonymous request, so this
      component only ever runs for a signed-in user. The previous version resolved
      the session on the client and flashed "Checking your session…" at every
      visitor, which is a second identity path and a worse first impression.
    * No duplicate initial fetch. The ViewModel is seeded rather than initialized
      empty, so mounting it does not immediately re-request the list it was just
      given. `Refresh` and every mutation still go through `/api/notes`.
-->
<script lang="ts">
import { NotesView } from '@starter/features/notes';
import { untrack } from 'svelte';
import { getNotesViewModel } from '#lib/composition/notes.ts';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();

// `untrack` says "I mean the value right now", which is exactly the intent: the
// ViewModel is created once and seeded with the list the server rendered. Reading
// `data.notes` bare here would be flagged as a reactive read captured outside a
// closure, and the fix for that warning — moving the read into an effect — would
// be wrong, because an effect does not run during server rendering and the first
// paint would go back to the loading state.
const viewModel = getNotesViewModel({
  initialNotes: untrack(() => data.notes),
  remote: untrack(() => data.remote),
});

// Re-seed when a client-side navigation produces a new list. Tracked on
// `data.notes` alone, so an in-place mutation that does not re-run the load does
// not overwrite what the user is looking at.
$effect(() => {
  viewModel.seed(data.notes);
});
</script>

<svelte:head>
  <title>Your notes</title>
</svelte:head>

<NotesView {viewModel} />

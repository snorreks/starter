<!--
  The notes route.

  A route page owns exactly one thing: constructing the ViewModel and handing it
  to the view. All logic lives in the ViewModel. If a page grows a second
  responsibility, the logic belongs in a ViewModel behind it.
-->
<script lang="ts">
import { NotesView } from '#lib/views/notes';
import { getNotesViewModel } from '#lib/views/notes/notes_composition';
import { sessionState, sessionService } from '#lib/services/session_service.svelte';
import { goto } from '$app/navigation';

const viewModel = getNotesViewModel();

// Resolve the session before deciding what to render, so a signed-in user
// never sees a flash of the sign-in prompt.
let resolving = $state(true);
void sessionService.refresh().finally(() => {
  resolving = false;
});

$effect(() => {
  if (!resolving && !sessionState.isAuthenticated) {
    void goto('/login');
  }
});
</script>

{#if resolving}
  <p role="status" aria-live="polite">Checking your session…</p>
{:else if sessionState.isAuthenticated}
  <NotesView {viewModel} />
{/if}

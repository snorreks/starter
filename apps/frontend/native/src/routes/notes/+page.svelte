<script lang="ts">
// The native notes route.
//
// The same screen the web app renders, from the same package: `NotesView`,
// `NotesViewModel` and `NotesService` are shared, and the only difference in this
// file is which transport is behind them. There is no second notes feature here,
// and there is no `+page.server.ts`: this app is prerendered, so there is no
// server render that could have seeded the list.
//
// Which is also why the first paint is a spinner. The web app's load returns
// notes with the HTML because a Worker can read the session cookie; this window
// has a bearer token it must present itself, so the list is fetched after mount.
// `viewModel.load()` is called once, guarded by the ViewModel's own stale guard,
// and every later refresh and mutation goes through the same service.
import { NotesView } from '@starter/features/notes';
import { NotesViewModel, notesService } from '#lib/composition/notes.ts';

const viewModel = new NotesViewModel({ notes: notesService });

$effect(() => {
  // `initialize` and not `load`: the difference is that `initialize` fetches once
  // and never again, so a re-run of this effect cannot double-fetch.
  void viewModel.initialize();
  return () => {
    // Cancellation on unmount — an in-flight list request is aborted rather than
    // resolving into a screen that no longer exists. `dispose` is async, and an
    // effect cleanup cannot await it.
    void viewModel.dispose();
  };
});
</script>

<svelte:head>
  <title>Your notes — Starter</title>
</svelte:head>

<NotesView {viewModel} />
<!--
  The notes screen.

  A View's job is markup, accessibility, DOM interaction and small presentation
  state. Everything else — what the notes are, whether a save is in flight,
  which error to show — belongs to the ViewModel.

  Explicit branches keep loading, failure and empty states visible in one place.

  Hydration note: the server rendered this exact list from `+page.server.ts`, and
  the ViewModel is seeded with it. Nothing here fetches on mount, so what a user
  sees before and after hydration is the same markup — a client fetch that races
  the first paint would flash an empty state over real content.
-->
<script lang="ts">
import { EmptyState, ErrorState, ScreenContainer, Spinner } from '@starter/ui';
import NoteCard from './note_card.svelte';
import NoteForm from './note_form.svelte';
import type { NotesViewModel } from './notes_view_model.svelte.ts';

type Props = {
  viewModel: NotesViewModel;
};

let { viewModel }: Props = $props();
</script>

<ScreenContainer screen={viewModel} element="section" id="notes-screen">
  <header class="notes__header">
    <div>
      <h1 class="notes__title">Your notes</h1>
      <p class="notes__subtitle">
        Stored in Cloudflare D1 and readable by this account only.
      </p>
    </div>
    <button
      type="button"
      class="ui-button ui-button--primary"
      onclick={() => viewModel.load()}
      disabled={viewModel.status.kind === 'loading'}
      data-testid="notes-refresh"
    >
      Refresh
    </button>
  </header>

  <NoteForm
    viewModel={viewModel}
    note={viewModel.noteBeingEdited}
    onCancelEdit={() => viewModel.startEditing(null)}
  />
  {#if viewModel.mutationError !== null}
    <p role="alert" class="notes__error" data-testid="notes-mutation-error">{viewModel.mutationError}</p>
  {/if}

  <div class="notes__body">
    {#if viewModel.status.kind === 'loading'}
      <div class="notes__loading" role="status" aria-live="polite">
        <Spinner />
        <span>Loading notes…</span>
      </div>
    {:else if viewModel.status.kind === 'error'}
      <ErrorState
        title="Could not load your notes"
        message={viewModel.status.message}
        retryable={viewModel.status.retryable}
        onRetry={() => viewModel.load()}
        testId="notes-error"
      />
    {:else if viewModel.notes.length === 0}
      <EmptyState
        title="No notes yet"
        body="Create your first note with the form above. It is saved to the server, not just this browser."
        testId="notes-empty"
      />
    {:else}
      <ul class="notes__list" data-testid="notes-list">
        {#each viewModel.notes as note (note.id)}
          <NoteCard
            {note}
            onEdit={(id) => viewModel.startEditing(id)}
            onDelete={(id) => {
              void viewModel.deleteNote(id);
            }}
          />
        {/each}
      </ul>
    {/if}
  </div>
</ScreenContainer>

<style>
  .notes__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  .notes__title {
    font-size: var(--font-size-2xl);
    line-height: var(--line-height-tight);
  }

  .notes__subtitle {
    margin-top: var(--space-1);
    color: var(--color-text-muted);
    font-size: var(--font-size-sm);
  }

  .notes__body {
    margin-top: var(--space-5);
  }

  .notes__list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .notes__loading {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    color: var(--color-text-muted);
  }

  .notes__error { color: var(--color-danger-text); }
</style>

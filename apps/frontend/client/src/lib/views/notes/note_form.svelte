<!--
  The create/edit composer.

  A worked example of "small presentation state stays in the View": whether the
  body textarea is expanded is local to this component. The draft text itself is
  ViewModel state, because a draft that vanished on navigation would be a bug.
-->
<script lang="ts">
import { type Note, validateNoteInput } from '@starter/schemas/notes';
import { Field } from '@starter/ui';
import type { NotesViewModel } from './notes_view_model.svelte.ts';

type Props = {
  viewModel: NotesViewModel;
  /** The note being edited, or undefined when creating. */
  note: Note | undefined;
  onCancelEdit: () => void;
};

let { viewModel, note, onCancelEdit }: Props = $props();

let title = $state('');
let body = $state('');
let errors = $state<Record<string, string>>({});

// Swap the draft when the edit target changes. Keyed on the note id so editing
// note A then note B does not leave A's text in the form.
$effect(() => {
  title = note?.title ?? '';
  body = note?.body ?? '';
  errors = {};
});

const isEditing = $derived(note !== undefined);

async function submit(event: SubmitEvent): Promise<void> {
  event.preventDefault();

  const found = validateNoteInput({ title, body });
  errors = found;

  if (Object.keys(found).length > 0) {
    return;
  }

  const payload = { title: title.trim(), body };
  // Narrow on `note` itself: `isEditing` is a derived boolean, and TypeScript
  // cannot infer that it implies `note` is defined.
  const target = note;
  const ok =
    target === undefined
      ? await viewModel.createNote(payload)
      : await viewModel.updateNote(target.id, payload);

  if (ok) {
    title = '';
    body = '';
    errors = {};
    if (target !== undefined) {
      onCancelEdit();
    }
  }
}
</script>

<form class="note-form" onsubmit={submit} data-testid="note-form" novalidate>
  <h2 class="note-form__heading">{isEditing ? 'Edit note' : 'New note'}</h2>

  <Field id="note-title" label="Title" required error={errors.title}>
    {#snippet children({ id, describedBy, invalid })}
      <input
        {id}
        class="note-form__input"
        type="text"
        autocomplete="off"
        value={title}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        oninput={(event) => (title = event.currentTarget.value)}
        data-testid="note-title-input"
      />
    {/snippet}
  </Field>

  <Field id="note-body" label="Body" error={errors.body} hint="Optional. Plain text.">
    {#snippet children({ id, describedBy, invalid })}
      <textarea
        {id}
        class="note-form__input note-form__textarea"
        rows="4"
        value={body}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        oninput={(event) => (body = event.currentTarget.value)}
        data-testid="note-body-input"
      ></textarea>
    {/snippet}
  </Field>

  <div class="note-form__actions">
    <button
      type="submit"
      class="ui-button ui-button--primary"
      disabled={viewModel.isMutating}
      data-testid="note-submit"
    >
      {#if viewModel.isMutating}
        Saving…
      {:else}
        {isEditing ? 'Save changes' : 'Create note'}
      {/if}
    </button>

    {#if isEditing}
      <button
        type="button"
        class="ui-button ui-button--secondary"
        onclick={onCancelEdit}
        data-testid="note-cancel"
      >
        Cancel
      </button>
    {/if}
  </div>
</form>

<style>
  .note-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin-top: var(--space-5);
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-subtle);
  }

  .note-form__heading {
    font-size: var(--font-size-lg);
  }

  .note-form__input {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    background: var(--color-surface);
    color: var(--color-text);
    font: inherit;
  }

  .note-form__input[aria-invalid='true'] {
    border-color: var(--color-danger);
  }

  .note-form__textarea {
    resize: vertical;
  }

  .note-form__actions {
    display: flex;
    gap: var(--space-2);
  }
</style>

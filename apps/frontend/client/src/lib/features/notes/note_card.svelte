<!--
  One note. Presentation only: it renders what it is given and raises intent.
  It holds no editable state of its own — a card that also managed a draft
  would give the list two sources of truth for the same note.
-->
<script lang="ts">
import type { Note } from '@starter/schemas/notes';
import { formatAbsoluteTime, formatRelativeTime } from '@starter/ui';
import { previewText } from '@starter/utils';

type Props = {
  note: Note;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
};

let { note, onEdit, onDelete }: Props = $props();

let expanded = $state(false);
const hasBody = $derived(note.body.trim().length > 0);
</script>

<li class="note-card" data-testid="note-card" data-note-id={note.id}>
  <div class="note-card__header">
    <h3 class="note-card__title">{note.title}</h3>
    <time
      class="note-card__updated"
      datetime={new Date(note.updatedAt).toISOString()}
      title={formatAbsoluteTime(note.updatedAt)}
    >
      {formatRelativeTime(note.updatedAt)}
    </time>
  </div>

  {#if hasBody}
    <p class="note-card__body" class:note-card__body--clamped={!expanded}>
      {expanded ? note.body : previewText(note.body, 180)}
    </p>
    {#if note.body.length > 180}
      <button
        type="button"
        class="note-card__toggle"
        onclick={() => (expanded = !expanded)}
        aria-expanded={expanded}
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    {/if}
  {/if}

  <div class="note-card__actions">
    <button
      type="button"
      class="ui-button ui-button--secondary"
      onclick={() => onEdit(note.id)}
      data-testid="note-edit"
    >
      Edit
      <span class="ui-visually-hidden"> “{note.title}”</span>
    </button>
    <button
      type="button"
      class="ui-button ui-button--danger-ghost"
      onclick={() => onDelete(note.id)}
      data-testid="note-delete"
    >
      Delete
      <span class="ui-visually-hidden"> “{note.title}”</span>
    </button>
  </div>
</li>

<style>
  .note-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }

  .note-card__header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .note-card__title {
    font-size: var(--font-size-lg);
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .note-card__updated {
    flex-shrink: 0;
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
  }

  .note-card__body {
    color: var(--color-text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .note-card__body--clamped {
    display: -webkit-box;
    line-clamp: 3;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .note-card__toggle {
    align-self: flex-start;
    background: none;
    border: none;
    padding: 0;
    color: var(--color-accent-text);
    font: inherit;
    font-size: var(--font-size-sm);
    text-decoration: underline;
    cursor: pointer;
  }

  .note-card__actions {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-1);
  }
</style>

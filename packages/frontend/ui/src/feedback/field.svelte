<!--
  A labelled form field with an error message wired to the input.

  `aria-describedby`, `aria-invalid` and `role="alert"` are the whole reason this
  component exists rather than an `<input>` plus a `<p>`: without them a
  validation failure is invisible to a screen reader and to automated checks.
-->
<script lang="ts">
import type { Snippet } from 'svelte';

type Props = {
  id: string;
  label: string;
  /** Validation message. Present => field is marked invalid. */
  error?: string;
  hint?: string;
  required?: boolean;
  children: Snippet<[{ id: string; describedBy: string | undefined; invalid: boolean }]>;
};

let { id, label, error, hint, required = false, children }: Props = $props();

// `$derived`, not `const`: a plain `const` captures `id` once, so a field
// whose `id` changed would keep pointing its `aria-describedby` at the
// previous element — a broken accessibility link that no test would notice.
const errorId = $derived(`${id}-error`);
const hintId = $derived(`${id}-hint`);
const describedBy = $derived(
  [error ? errorId : undefined, hint ? hintId : undefined].filter(Boolean).join(' ') || undefined,
);
</script>

<div class="ui-field" class:ui-field--invalid={Boolean(error)}>
  <label class="ui-field__label" for={id}>
    {label}
    {#if required}<span aria-hidden="true"> *</span>{/if}
  </label>

  {@render children({ id, describedBy, invalid: Boolean(error) })}

  {#if hint}
    <p class="ui-field__hint" id={hintId}>{hint}</p>
  {/if}
  {#if error}
    <p class="ui-field__error" id={errorId} role="alert">{error}</p>
  {/if}
</div>

<style>
  .ui-field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .ui-field__label {
    font-size: var(--font-size-sm);
    font-weight: 600;
  }

  .ui-field__hint {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
  }

  .ui-field__error {
    font-size: var(--font-size-sm);
    color: var(--color-danger-text);
  }
</style>

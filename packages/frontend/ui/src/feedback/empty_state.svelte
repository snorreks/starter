<!--
  The empty state. It exists so "nothing here yet" is a designed screen with a
  next action, not a blank region the user has to interpret.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  type Props = {
    title: string;
    body?: string;
    /** Test id, so E2E can assert the empty state without matching copy. */
    testId?: string;
    action?: Snippet;
  };

  let { title, body, testId = 'empty-state', action }: Props = $props();
</script>

<div class="ui-empty" data-testid={testId}>
  <p class="ui-empty__title">{title}</p>
  {#if body}<p class="ui-empty__body">{body}</p>{/if}
  {#if action}<div class="ui-empty__action">{@render action()}</div>{/if}
</div>

<style>
  .ui-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-8) var(--space-4);
    text-align: center;
    border: 1px dashed var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface-subtle);
  }

  .ui-empty__title {
    font-weight: 600;
  }

  .ui-empty__body {
    color: var(--color-text-muted);
    max-width: 34ch;
  }
</style>

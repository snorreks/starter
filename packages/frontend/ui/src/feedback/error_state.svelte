<!--
  A recoverable error.

  The important property is that it never claims success and never says
  "something went wrong" alone: it says what failed, whether retrying can help,
  and offers the retry. A backend outage that silently reports a successful
  write is the failure mode this component exists to prevent.
-->
<script lang="ts">
  type Props = {
    title?: string;
    message: string;
    /** False when a retry would deterministically fail (e.g. 403). */
    retryable?: boolean;
    onRetry?: () => void;
    testId?: string;
  };

  let {
    title = 'Something went wrong',
    message,
    retryable = true,
    onRetry,
    testId = 'error-state',
  }: Props = $props();
</script>

<div class="ui-error" role="alert" data-testid={testId}>
  <p class="ui-error__title">{title}</p>
  <p class="ui-error__message">{message}</p>
  {#if onRetry && retryable}
    <button type="button" class="ui-error__retry" onclick={onRetry} data-testid="{testId}-retry">
      Try again
    </button>
  {/if}
</div>

<style>
  .ui-error {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    padding: var(--space-4);
    border: 1px solid var(--color-danger-border);
    border-radius: var(--radius-md);
    background: var(--color-danger-subtle);
    color: var(--color-danger-text);
  }

  .ui-error__title {
    font-weight: 600;
  }

  .ui-error__message {
    color: inherit;
  }

  .ui-error__retry {
    margin-top: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border: 1px solid currentColor;
    border-radius: var(--radius-sm);
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }

  .ui-error__retry:hover {
    background: var(--color-danger-hover);
  }
</style>

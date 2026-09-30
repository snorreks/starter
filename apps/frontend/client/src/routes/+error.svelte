<!--
  Route-level error boundary. SvelteKit renders this when a `+page`/`+layout`
  load or render throws. It reports honestly rather than implying the app is
  fine: a blank screen after a failed load is the worst possible outcome.
-->
<script lang="ts">
import { page } from '$app/state';
</script>

<div class="route-error" role="alert">
  <h1>This page could not be loaded</h1>
  <p class="route-error__status">
    {page.status} {page.error?.message ?? 'An unexpected error occurred.'}
  </p>
  <a class="ui-button ui-button--primary" href="/">Go to the start</a>
</div>

<style>
  .route-error {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-3);
    padding: var(--space-5);
    border: 1px solid var(--color-danger-border);
    border-radius: var(--radius-md);
    background: var(--color-danger-subtle);
  }

  .route-error__status {
    color: var(--color-danger-text);
  }
</style>

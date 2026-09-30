<!--
  A spinner that does not lie. `role="status"` with a text label means a screen
  reader announces the wait; a spinning div with no accessible name announces
  nothing at all.
-->
<script lang="ts">
  type Props = {
    /** Accessible name. Empty renders an aria-hidden decorative spinner. */
    label?: string;
    size?: 'sm' | 'md';
  };

  let { label = '', size = 'md' }: Props = $props();
</script>

<span
  class="ui-spinner"
  class:ui-spinner--sm={size === 'sm'}
  role={label ? 'status' : undefined}
  aria-label={label || undefined}
  aria-hidden={label ? undefined : 'true'}
>
  <span class="ui-spinner__ring"></span>
  {#if label}<span class="ui-visually-hidden">{label}</span>{/if}
</span>

<style>
  .ui-spinner {
    display: inline-flex;
    color: var(--color-text-muted);
  }

  .ui-spinner__ring {
    width: 1.5rem;
    height: 1.5rem;
    border: 2px solid currentColor;
    border-top-color: transparent;
    border-radius: 50%;
    animation: ui-spin 700ms linear infinite;
  }

  .ui-spinner--sm .ui-spinner__ring {
    width: 1rem;
    height: 1rem;
  }

  @keyframes ui-spin {
    to {
      transform: rotate(360deg);
    }
  }

  /* Honour the OS preference rather than animating unconditionally. */
  @media (prefers-reduced-motion: reduce) {
    .ui-spinner__ring {
      animation-duration: 2400ms;
    }
  }
</style>

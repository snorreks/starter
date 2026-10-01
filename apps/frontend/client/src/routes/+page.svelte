// apps/frontend/client/src/routes/+page.svelte
<!--
  The public landing page.

  Deliberately minimal, and the reason is a decision rather than an omission: this
  PR is about where the application runs, not about what it does. One Worker serves
  this page, `/notes` and `/api/*` from one origin, so the landing page is the proof
  that a server-rendered public route and an authenticated route can live in the
  same application. Adding product surface here is a separate change.
-->
<script lang="ts">
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();
</script>

<svelte:head>
  <title>Starter</title>
  <meta
    name="description"
    content="A SvelteKit application on one Cloudflare Worker, with D1 and Better Auth."
  />
</svelte:head>

<section class="landing">
  <h1 class="landing__title">One application, one Worker</h1>
  <p class="landing__lede">
    This page is rendered by the same Worker that serves the API and the assets, from the same
    origin, with no proxy in between.
  </p>

  <div class="landing__actions">
    {#if data.user}
      <a class="ui-button ui-button--primary" href="/notes" data-testid="landing-notes-link">
        Your notes
      </a>
    {:else}
      <a class="ui-button ui-button--primary" href="/login" data-testid="landing-sign-in-link">
        Sign in
      </a>
    {/if}
  </div>
</section>

<style>
  .landing {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-4);
    padding: var(--space-6) 0;
  }

  .landing__title {
    font-size: var(--font-size-xl);
    margin: 0;
  }

  .landing__lede {
    max-width: 38rem;
    color: var(--color-text-muted);
    margin: 0;
  }

  .landing__actions {
    display: flex;
    gap: var(--space-3);
  }
</style>

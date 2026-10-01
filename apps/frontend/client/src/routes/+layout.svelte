<!--
  The app shell. Installs the logger before anything else can log, and provides
  the dialog capability the base classes use for snackbars and confirmations.
-->
<script lang="ts">
import '@starter/ui/tokens.css';
import '../app.css';
import '#lib/runtime/logger';
import { setDialogCapabilities } from '@starter/frontend-services/base';
import type { Snippet } from 'svelte';
import { untrack } from 'svelte';
import { sessionService, sessionState } from '#lib/services/session_service.svelte';
import { goto, invalidateAll } from '$app/navigation';
import type { LayoutData } from './$types';

type Props = { data: LayoutData; children: Snippet };
let { data, children }: Props = $props();

// Dialog capability: the base classes reach user-facing dialogs through this
// object rather than importing the app's component tree, which is what keeps
// a ViewModel testable without mounting anything.
setDialogCapabilities({
  showSnackbar: (snackbar) => {
    // Round 1 has no toast system. Console output keeps the contract honest:
    // a snackbar is requested, and the fact that no UI renders it is visible
    // rather than silently swallowed. See docs/first-round-review.md.
    console.info(`[snackbar:${snackbar.tone}] ${snackbar.text}`);
  },
  confirm: async () => window.confirm('Are you sure?'),
  requestSignIn: () => {
    void goto('/login');
  },
});

let user = $state(sessionState.user);
$effect(() => sessionState.subscribe((next) => (user = next)));

// Seeded from the server's answer rather than fetched. `locals.user` is already
// the verified identity, so a browser round trip here has exactly two possible
// outcomes — the same answer, or the server and the browser disagreeing about who
// is signed in — and the second is a bug rather than a refresh.
//
// `untrack` because this runs once, on both the server and the client, and only
// the value at this moment is wanted. After a client-side navigation SvelteKit
// re-runs the load and hands the component new props, and the *server* has already
// re-rendered every page from them — the browser state is then brought back into
// agreement by `invalidateAll()` and the sign-out path below, both of which are
// explicit about it. Re-seeding reactively here would instead overwrite a session
// the user just established by signing in.
sessionState.set(untrack(() => data.user));

async function signOut(): Promise<void> {
  await sessionService.signOut();
  // The server has to re-render: `/notes` redirects on its load, and this shell's
  // sign-in link comes from the layout load. Navigating without invalidating would
  // leave both describing the session that just ended.
  await invalidateAll();
  await goto('/login');
}
</script>

<div class="shell">
  <header class="shell__bar">
    <a class="shell__brand" href="/">Starter</a>

    <nav class="shell__nav" aria-label="Primary">
      {#if user}
        <span class="shell__user" data-testid="current-user">{user.email}</span>
        <button type="button" class="ui-button ui-button--secondary" onclick={signOut}>
          Sign out
        </button>
      {:else}
        <a class="ui-button ui-button--secondary" href="/login" data-testid="sign-in-link">
          Sign in
        </a>
      {/if}
    </nav>
  </header>

  <main class="shell__main">
    {@render children()}
  </main>
</div>

<style>
  .shell {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }

  .shell__bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    padding: var(--space-3) var(--space-5);
    border-bottom: 1px solid var(--color-border);
    background: var(--color-surface);
  }

  .shell__brand {
    font-weight: 700;
    font-size: var(--font-size-lg);
    color: var(--color-text);
    text-decoration: none;
  }

  .shell__nav {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }

  .shell__user {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
  }

  .shell__main {
    flex: 1;
    width: 100%;
    max-width: 56rem;
    margin: 0 auto;
    padding: var(--space-5);
  }
</style>

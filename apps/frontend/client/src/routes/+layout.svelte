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
import { installNativeSessionBridge } from '#lib/platform/native_session';
import { sessionService, sessionState } from '#lib/services/session_service.svelte';
import { goto } from '$app/navigation';

type Props = { children: Snippet };
let { children }: Props = $props();

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

void installNativeSessionBridge();

let user = $state(sessionState.user);
$effect(() => sessionState.subscribe((next) => (user = next)));

async function signOut(): Promise<void> {
  await sessionService.signOut();
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

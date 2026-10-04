<!--
  The native app shell: identity, sign-out, and the one navigation rule.

  Sign-out is the interesting part, and the order is the whole design:

    1. `authSessionService.signOut()` — the *server* revokes the session, so a
       token that leaked out of this window stops working. Doing this locally
       first would leave a live credential on the server.
    2. `discardSession()` — the in-memory token goes, and the vault entry is
       removed (or queued, if the vault is locked).
    3. Navigate.

  A failure in step 1 must not leave the window looking signed in, so the local
  discard runs regardless and the failure is reported. A window that says
  "signed in" after the server has revoked the session is the worse of the two
  states to be in.
-->
<script lang="ts">
import '@starter/ui/tokens.css';
import '../app.css';
import { onMount, type Snippet, untrack } from 'svelte';
import {
  authSessionService,
  discardSession,
  nativeNavigation,
  sessionState,
} from '#lib/composition/session.ts';

type Props = { children: Snippet };
let { children }: Props = $props();

let user = $state(untrack(() => sessionState.user));
let signOutError = $state('');

onMount(() => {
  // One check on start: the credential may have been restored from the vault, and
  // the window must show who it belongs to without waiting for a click.
  void authSessionService.refresh();
  return sessionState.subscribe((next) => {
    user = next;
  });
});

async function signOut(): Promise<void> {
  signOutError = '';
  try {
    await authSessionService.signOut();
  } catch (error) {
    signOutError =
      error instanceof Error ? error.message : 'The server could not revoke the session.';
  }
  await discardSession();
  await nativeNavigation.go('/');
}
</script>

<div class="shell">
  <header class="shell__bar">
    <a class="shell__brand" href="/">Starter</a>
    <nav class="shell__nav" aria-label="Primary">
      {#if user}
        <a class="shell__link" href="/notes" data-testid="native-notes-link">Notes</a>
        <a class="shell__link" href="/jobs" data-testid="native-jobs-link">Jobs</a>
        <span class="shell__user" data-testid="native-current-user">{user.email}</span>
        <button type="button" class="ui-button ui-button--secondary" onclick={signOut} data-testid="native-sign-out">
          Sign out
        </button>
      {:else}
        <a class="ui-button ui-button--secondary" href="/" data-testid="native-sign-in-link">
          Sign in
        </a>
      {/if}
    </nav>
  </header>

  <main class="shell__main">
    {#if signOutError}
      <p role="alert" data-testid="native-sign-out-error">{signOutError}</p>
    {/if}
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

  .shell__link {
    font-size: var(--font-size-sm);
    color: var(--color-text);
    text-decoration: none;
  }

  .shell__link:hover {
    text-decoration: underline;
  }

  .shell__main {
    flex: 1;
    width: 100%;
    /* A phone-sized width, not the desktop app's 56rem: the window may be
       resized narrow, and a fixed desktop maximum is what produces a
       horizontally scrolling window on a small screen. */
    max-width: 48rem;
    margin: 0 auto;
    padding: var(--space-5);
  }
</style>
<!--
  The app shell. Installs the logger before anything else can log, and provides
  the dialog capability the base classes use for snackbars and confirmations.
-->
<script lang="ts">
import '@starter/ui/tokens.css';
import '../app.css';
import '#lib/runtime/logger';
import { setDialogCapabilities } from '@starter/ui';
import type { Snippet } from 'svelte';
import { untrack } from 'svelte';
import { sessionService, sessionState } from '#lib/composition/session.ts';
import { goto, invalidateAll } from '$app/navigation';
import type { LayoutData } from './$types';

type Props = { data: LayoutData; children: Snippet };
let { data, children }: Props = $props();

// The feedback capability screens reach for. Registered here rather than imported
// by them: a ViewModel that imported this layout would be a cycle, and would be
// unusable in any test that did not mount the shell.
setDialogCapabilities({
  showSnackbar: (snackbar) => {
    // No toast system yet. Console output keeps the contract honest: a snackbar is
    // requested, and the fact that no UI renders it is visible rather than
    // silently swallowed. See docs/first-round-review.md.
    console.info(`[snackbar:${snackbar.tone}] ${snackbar.text}`);
  },
  confirm: async () => window.confirm('Are you sure?'),
});

// The server's answer is the identity. `locals.user` is already verified, so a
// browser round trip here has exactly two possible outcomes — the same answer, or
// the server and the browser disagreeing about who is signed in — and the second
// is a bug rather than a refresh.
//
// Read for the first render on both sides, and *written* into the client-side
// session state from an effect rather than at component initialisation. An effect
// does not run during SSR, so a request rendered on the server no longer writes
// to module-scope state at all. That is the specific thing that matters here: the
// session state is one object for the whole Worker isolate, so two concurrent
// requests assigning to it would render whichever request arrived last — a signed
// out user shown somebody else's address, from a page that cannot be cached.
//
// `untrack` for the same reason as before: this is the value at this moment, not a
// live binding.
let user = $state(untrack(() => data.user));

$effect(() => {
  // Browser only. Brings the client session into agreement with what the server
  // just said, and follows later navigations: SvelteKit re-runs the load and hands
  // this component new props, and `invalidateAll()` after a sign-in or sign-out is
  // what triggers it. Both are explicit about wanting it — re-seeding on every
  // value read would instead overwrite a session the user just established by
  // signing in.
  sessionState.set(data.user);
  return sessionState.subscribe((next) => (user = next));
});

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
        <a class="shell__link" href="/notes" data-testid="notes-link">Notes</a>
        <a class="shell__link" href="/jobs" data-testid="jobs-link">Jobs</a>
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
    /* Wraps rather than overflowing. A sign-in address and a row of navigation
       links are both wide, and a phone-sized window must not scroll sideways to
       reach either of them. */
    flex-wrap: wrap;
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
    flex-wrap: wrap;
  }

  .shell__user {
    /* A long address is the widest thing in the bar; it may break, not push. */
    min-width: 0;
    overflow-wrap: anywhere;
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
    max-width: 56rem;
    margin: 0 auto;
    padding: var(--space-5);
  }
</style>

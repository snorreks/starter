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
import { browserLifecycleEvents, createAppLifecycle } from '#lib/platform/app_lifecycle.ts';

type Props = { children: Snippet };
let { children }: Props = $props();

let user = $state(untrack(() => sessionState.user));
let signOutError = $state('');
/**
 * True while the OS has taken the window away or the device has no network.
 *
 * Shown, not acted on. The recovery is a single tap rather than an automatic
 * retry, for two reasons that are both about correctness rather than taste: a
 * retry of a request that may have been received duplicates it, and a phone that
 * regains connectivity in a lift would otherwise hammer a server it cannot reach.
 */
let unreachable = $state(false);

onMount(() => {
  // One check on start: the credential may have been restored from the vault, and
  // the window must show who it belongs to without waiting for a click.
  void authSessionService.refresh();
  const unsubscribe = sessionState.subscribe((next) => {
    user = next;
  });

  // Suspend, resume and connectivity. A phone is the first platform here where
  // the page outlives several minutes of inattention, and the interesting events
  // are the ones that fire while nothing is on screen.
  const events = browserLifecycleEvents();
  const lifecycle =
    events === null
      ? null
      : createAppLifecycle({
          events,
          onChange: (phase) => {
            unreachable = phase !== 'active';
            // Coming back is the one moment a refresh is safe and correct: the
            // session may have been revoked on another device, and the list on
            // screen may be hours old.
            if (phase === 'active') {
              void authSessionService.refresh();
            }
          },
        });

  return () => {
    unsubscribe();
    lifecycle?.dispose();
  };
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
    {#if unreachable}
      <!--
        `role="status"` rather than `alert`: it is information, not an error the
        user caused, and an assertive live region for something that happens every
        time a phone sleeps would talk over whatever the screen reader was saying.
      -->
      <p role="status" data-testid="native-unreachable">
        Offline, or this app is in the background. Pull to refresh when you are back.
      </p>
    {/if}
    {@render children()}
  </main>
</div>

<style>
  .shell {
    /*
      `100vh`, then `100dvh` where it exists.

      On a phone the keyboard resizes the *visual* viewport and `vh` does not
      follow: `100vh` keeps the layout taller than the screen, which puts the
      sign-in field under the keyboard instead of scrolling it into view. `dvh` is
      the value that tracks. The pair is deliberate — an engine that understands
      only the first keeps it, and an engine that understands both takes the
      second, because the later declaration wins.
    */
    min-height: 100vh;

    display: flex;
    flex-direction: column;
  }

  @supports (height: 100dvh) {
    .shell {
      min-height: 100dvh;
    }
  }

  .shell__bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
    /*
      The safe-area insets, applied to the bar and the main column rather than to
      `<body>`. A fixed-position element — a sticky header, a toast — reads them
      itself; everything in normal flow is inset once, here, and no component has
      to know the device has a notch. `--safe-*` is defined in `app.css` with a
      0px fallback, so this is a no-op on a desktop webview.
    */
    padding: calc(var(--space-3) + var(--safe-top)) calc(var(--space-5) + var(--safe-right))
      var(--space-3) calc(var(--space-5) + var(--safe-left));
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
    /* Wraps rather than overflows. A signed-in email plus a Sign out button is
       two unbreakable strings, and on a 360dp phone they do not fit on one line;
       `overflow-x: hidden` on the body would have hidden the second one instead. */
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .shell__user {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
    /* An email address is one long token and the most common thing in this bar. */
    overflow-wrap: anywhere;
    min-width: 0;
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
    /* The bottom inset is the home indicator. Without it the last row of a list
       sits under the gesture bar and cannot be read. */
    padding: var(--space-5) calc(var(--space-5) + var(--safe-right))
      calc(var(--space-5) + var(--safe-bottom)) calc(var(--space-5) + var(--safe-left));
  }
</style>
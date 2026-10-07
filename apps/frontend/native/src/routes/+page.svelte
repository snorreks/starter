<script lang="ts">
// The native app's sign-in screen: device authorization, approved in the user's
// own browser.
//
// Why not a password field
// -----------------------
// A desktop client that collects a password is a desktop client that has the
// password. The device flow avoids it entirely: this app asks the server for a
// short code, the *user's browser* — which already holds their account and their
// session — approves it, and this window receives a session token from the same
// server that would otherwise have verified a password. There is no custom signed
// token and no client secret; `client_id` below is public and is compiled into
// this bundle.
//
// What this component owns is the wiring, because the decisions live one layer
// down and are unit-tested there: the polling rules are
// `@starter/features`' `DeviceAuthorizationService`, the URL allowance is
// `createExternalBrowser`, and where the token lands is `VaultSessionStore`.
//
// The one thing that genuinely belongs here is the lifecycle: a polling loop must
// stop when the screen goes away, or a closed window leaves a device code alive
// and a timer pending. `onDestroy` aborts, and `awaitApproval` treats an abort as
// cancellation rather than as a failure.

import { createDeviceAuthorizationService } from '@starter/features/auth';
import { onDestroy, onMount } from 'svelte';
import {
  adoptSession,
  apiOrigin,
  authSessionService,
  beginSupabaseOAuth,
  externalBrowser,
  nativeNavigation,
  nativeTransport,
  refreshNativeSession,
  sessionState,
  supabaseNativeAuth,
  supabaseVaultStore,
  unlockSupabaseVault,
  unlockVault,
  vaultStore,
} from '#lib/composition/session.ts';
import { nativeConfig } from '#lib/runtime/config.ts';

type Phase =
  | 'signed-out'
  | 'requesting'
  | 'waiting'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'error'
  | 'cancelled';

const deviceService = createDeviceAuthorizationService({
  transport: nativeTransport,
  clientId: nativeConfig.clientId,
});

let phase = $state<Phase>('signed-out');
let userCode = $state('');
let statusText = $state('');
let errorText = $state('');
let remember = $state(false);
let passphrase = $state('');
let vaultAvailable = $state(false);
let reauthenticationRequired = $state(false);

let inFlight = new AbortController();

onDestroy(() => {
  inFlight.abort();
});

const activeVault = supabaseVaultStore ?? vaultStore;
activeVault.isAvailable().then((available) => {
  vaultAvailable = available;
});

onMount(async () => {
  await refreshNativeSession();
  reauthenticationRequired = supabaseNativeAuth?.requiresReauthentication ?? false;
});

async function signInWithBrowser(): Promise<void> {
  errorText = '';
  inFlight.abort();
  inFlight = new AbortController();
  const { signal } = inFlight;

  try {
    if (nativeConfig.authProfile === 'supabase') {
      if (remember && !(await activeVault.isAvailable())) {
        if (passphrase.length === 0) {
          errorText = 'Enter a passphrase to unlock the secure store, or clear "remember me".';
          return;
        }
        await unlockSupabaseVault(passphrase);
        passphrase = '';
        vaultAvailable = true;
        reauthenticationRequired = supabaseNativeAuth?.requiresReauthentication ?? false;
        if (supabaseNativeAuth?.accessToken) {
          await nativeNavigation.go('/notes');
          return;
        }
      }
      phase = 'waiting';
      statusText = 'Opening Supabase sign-in in your browser…';
      await beginSupabaseOAuth('google', remember);
      statusText = 'Complete sign-in in your browser. This app will reopen when it is finished.';
      return;
    }

    if (remember && !(await activeVault.isAvailable())) {
      if (passphrase.length === 0) {
        errorText = 'Enter a passphrase to unlock the vault, or clear "remember me".';
        return;
      }
      await unlockVault(passphrase);
      vaultAvailable = true;
      // A remembered session, if there was one, was restored above. If the user
      // asked to remember this one and already had a session, that is the old
      // account: signing out of it is cheaper than carrying two credentials.
      await authSessionService.signOut().catch(() => undefined);
    }

    phase = 'requesting';
    statusText = 'Asking the server for a sign-in code…';
    const code = await deviceService.requestCode(signal);

    userCode = code.user_code;
    phase = 'waiting';
    statusText = 'Waiting for you to approve this device in your browser.';

    // Out to the user's own browser, never a webview: see external_browser.ts.
    await externalBrowser.open(code.verification_uri_complete);

    const outcome = await deviceService.awaitApproval(code, signal);

    if (outcome.status === 'denied') {
      phase = 'denied';
      errorText = 'That request was denied in the browser. Nothing was stored.';
      return;
    }
    if (outcome.status === 'expired') {
      phase = 'expired';
      errorText = 'That code expired before it was approved. Start again.';
      return;
    }

    phase = 'approved';
    statusText = 'Approved. Loading your account…';

    // Adopt first, then resolve: the identity comes from the server with the new
    // credential in hand, so there is exactly one answer to "who is signed in".
    await adoptSession(outcome.token.access_token, 'pending', false);
    const user = await authSessionService.refresh(signal);

    if (user === null) {
      await authSessionService.signOut().catch(() => undefined);
      phase = 'error';
      errorText = 'The server did not accept that token. Nothing was stored.';
      return;
    }

    if (remember) {
      await adoptSession(outcome.token.access_token, user.id, true);
      passphrase = '';
    } else {
      adoptSession(outcome.token.access_token, user.id, false);
    }

    await nativeNavigation.go('/notes');
  } catch (error) {
    // Cancellation is not a failure. Reporting it as one puts an error on the
    // screen every time the user navigates away mid-flow.
    if (
      error instanceof Error &&
      (error.name === 'AbortError' || /cancelled/i.test(error.message))
    ) {
      phase = 'cancelled';
      return;
    }
    phase = 'error';
    errorText = error instanceof Error ? error.message : 'Sign-in failed.';
  }
}
</script>

<svelte:head>
  <title>Sign in — Starter</title>
</svelte:head>

<section id="sign-in-screen">
  <h1>Sign in</h1>

  {#if sessionState.user}
    <p data-testid="native-signed-in">Signed in as {sessionState.user.email}.</p>
    <a class="ui-button ui-button--primary" href="/notes" data-testid="native-notes-link">
      Go to your notes
    </a>
  {:else}
    {#if reauthenticationRequired}
      <p role="status" data-testid="native-reauth-required">
        A saved session used an older credential format and was removed. Sign in again to create a secure Supabase session.
      </p>
    {/if}
    <p class="native__explain">
      {#if nativeConfig.authProfile === 'supabase'}
        This app opens Supabase in your browser. After sign-in, the one-time callback returns here.
      {:else}
        This app never asks for your password. It shows a short code, your browser approves it, and
        the session comes back to this window.
      {/if}
    </p>

    <button
      type="button"
      class="ui-button ui-button--primary"
      data-testid="native-sign-in"
      disabled={phase === 'requesting' || phase === 'waiting'}
      onclick={signInWithBrowser}
    >
      Sign in with your browser
    </button>

    <label class="native__remember">
      <input type="checkbox" bind:checked={remember} data-testid="native-remember" />
      Remember me on this device (stores credentials in an encrypted vault)
    </label>

    {#if remember && !vaultAvailable}
      <label class="native__passphrase">
        Vault passphrase
        <input
          type="password"
          bind:value={passphrase}
          data-testid="native-passphrase"
          autocomplete="current-password"
        />
      </label>
      <p class="native__explain">
        The passphrase is not stored anywhere, not even next to the vault. Without it, nothing
        survives closing the app — which is the default.
      </p>
    {/if}

    {#if userCode}
      <p class="native__code" data-testid="native-user-code">
        Enter this code if your browser did not open automatically: <strong>{userCode}</strong>
      </p>
    {/if}

    {#if statusText}
      <p role="status" aria-live="polite" data-testid="native-status">{statusText}</p>
    {/if}

    {#if errorText}
      <p role="alert" data-testid="native-error">{errorText}</p>
    {/if}

    <p class="native__origin" data-testid="native-origin">API: {apiOrigin}</p>
  {/if}
</section>

<style>
  #sign-in-screen {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    max-width: 34rem;
  }

  .native__explain {
    color: var(--color-text-muted);
    font-size: var(--font-size-sm);
  }

  .native__remember,
  .native__passphrase {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    font-size: var(--font-size-sm);
  }

  .native__passphrase {
    flex-direction: column;
    align-items: stretch;
  }

  .native__code {
    font-family: ui-monospace, monospace;
    letter-spacing: 0.08em;
  }

  .native__origin {
    color: var(--color-text-muted);
    font-size: var(--font-size-xs);
  }
</style>

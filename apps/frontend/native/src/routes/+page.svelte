<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { createNativeSignInViewModel } from '#lib/composition/session.ts';

const viewModel = createNativeSignInViewModel();
onMount(() => {
  void viewModel.initialize();
});
onDestroy(viewModel.dispose);
</script>


<svelte:head>
  <title>Sign in — Starter</title>
</svelte:head>

<section id="sign-in-screen">
  <h1>Sign in</h1>

  {#if viewModel.user}
    <p data-testid="native-signed-in">Signed in as {viewModel.user.email}.</p>
    <a class="ui-button ui-button--primary" href="/notes" data-testid="native-notes-link">
      Go to your notes
    </a>
  {:else}
    {#if viewModel.reauthenticationRequired}
      <p role="status" data-testid="native-reauth-required">
        A saved session used an older credential format and was removed. Sign in again to create a secure Supabase session.
      </p>
    {/if}
    <p class="native__explain">
      This app opens Supabase in your browser. After sign-in, the one-time callback returns here.
    </p>

    <button
      type="button"
      class="ui-button ui-button--primary"
      data-testid="native-sign-in"
      disabled={viewModel.busy}
      onclick={viewModel.signInWithBrowser}
    >
      Sign in with your browser
    </button>

    <label class="native__remember">
      <input type="checkbox" bind:checked={viewModel.remember} data-testid="native-remember" />
      Remember me on this device (stores credentials in an encrypted vault)
    </label>

    {#if viewModel.remember && !viewModel.vaultAvailable}
      <label class="native__passphrase">
        Vault passphrase
        <input
          type="password"
          bind:value={viewModel.passphrase}
          data-testid="native-passphrase"
          autocomplete="current-password"
        />
      </label>
      <p class="native__explain">
        The passphrase is not stored anywhere, not even next to the vault. Without it, nothing
        survives closing the app — which is the default.
      </p>
    {/if}

    {#if viewModel.statusText}
      <p role="status" aria-live="polite" data-testid="native-status">{viewModel.statusText}</p>
    {/if}

    {#if viewModel.errorText}
      <p role="alert" data-testid="native-error">{viewModel.errorText}</p>
    {/if}

    <p class="native__origin" data-testid="native-origin">API: {viewModel.apiOrigin}</p>
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

  .native__origin {
    color: var(--color-text-muted);
    font-size: var(--font-size-xs);
  }
</style>

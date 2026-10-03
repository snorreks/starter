<!--
  The device-approval screen.

  Everything this page shows comes from the server: the code came out of the URL,
  but whether it exists, who is waiting on it and what state it is in were read
  back through `readDeviceAuthorization` in `+page.server.ts`. The two buttons post
  form actions, which re-issue through Better Auth's handler so the origin check and
  the rate limiter still apply.

  The one piece of copy that matters is the middle line: this page approves a
  *device*, and a user who cannot tell which device they are approving cannot make
  an informed decision. So the client id and the code are both shown, and there is
  no "approve everything" path.
-->
<script lang="ts">
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();

const decided = $derived(data.outcome);
const status = $derived(data.state?.status ?? null);
const canDecide = $derived(data.state !== null && status === 'pending');
</script>

<svelte:head>
  <title>Approve a device — Starter</title>
</svelte:head>

<section id="device-screen">
  <h1>Approve a device</h1>

  {#if data.userCode === null}
    <p data-testid="device-missing">
      No device code was supplied. Open the link from the application that asked for it, or start
      the sign-in again there.
    </p>
  {:else if data.state === null}
    <p role="alert" data-testid="device-unknown">
      That code is not one this server recognises, or it has already expired. Codes work once.
    </p>
  {:else}
    <p>
      An application is asking to sign in as
      <strong data-testid="device-client">{data.state.clientId ?? 'an unnamed client'}</strong>.
    </p>
    <p class="device__code" data-testid="device-code">{data.userCode}</p>

    {#if decided === 'device/approve'}
      <p role="status" data-testid="device-decided-approved">
        Approved. The application has been told, and can pick up its session.
      </p>
    {:else if decided === 'device/deny'}
      <p role="status" data-testid="device-decided-denied">
        Denied. The application will not receive a session.
      </p>
    {/if}

    {#if canDecide}
      <div class="device__actions">
        <form method="POST" action="?/approve">
          <button
            type="submit"
            class="ui-button ui-button--primary"
            data-testid="device-approve">{decided ? 'Approve again' : 'Approve'}</button
          >
        </form>
        <form method="POST" action="?/deny">
          <button
            type="submit"
            class="ui-button ui-button--secondary"
            data-testid="device-deny">{decided ? 'Deny again' : 'Deny'}</button
          >
        </form>
      </div>
    {:else if status !== 'pending'}
      <p role="status" data-testid="device-status">
        This request was already {status}. Codes work once.
      </p>
    {/if}
  {/if}
</section>

<style>
  #device-screen {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    max-width: 34rem;
  }

  .device__code {
    font-family: ui-monospace, monospace;
    font-size: var(--font-size-xl);
    letter-spacing: 0.12em;
  }

  .device__actions {
    display: flex;
    gap: var(--space-3);
  }
</style>
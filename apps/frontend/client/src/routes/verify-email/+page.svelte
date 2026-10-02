<!--
  The address-confirmation landing page.

  Three states, and which one renders is decided by the server's load from the
  verified session — not by whether the URL looks like a success. A bare visit and a
  successful confirmation arrive with an identical URL, and treating them the same
  would mean telling someone their address is verified on the strength of nothing.

  No ViewModel: the whole screen is three mutually exclusive paragraphs chosen from
  three booleans the server already computed.
-->
<script lang="ts">
import type { ActionData, PageData } from './$types';

let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<section id="verify-email-screen" aria-labelledby="verify-heading">
  <h1 id="verify-heading">Confirm your address</h1>

  {#if form?.sent === true}
    <p role="status">
      If that address has an account, a confirmation link is on its way.
    </p>
  {:else if data.error !== null}
    <p role="alert">
      {#if data.expired}
        That link has expired. Ask for a new one below.
      {:else}
        That link is not valid any more. It may already have been used.
      {/if}
    </p>
    {@render resend(data.email)}
  {:else if data.verified}
    <!--
      Only reachable when the caller is already signed in *and* the server says the
      address is confirmed. Following a verification link while signed out is the
      common case and falls through to the "check your inbox" branch below, which is
      deliberate: with no session there is nothing to read the outcome from, and
      claiming success on the strength of an absent `?error` would congratulate
      somebody whose address is not verified.
    -->
    <p role="status">
      {#if data.email !== null}
        {data.email} is confirmed.
      {:else}
        That address is confirmed.
      {/if}
    </p>
    <p><a href="/login">Sign in</a></p>
  {:else}
    <p>
      Open the confirmation link from your email. This page updates once you have
      followed it.
    </p>
    {#if data.email !== null}
      <p class="lede">Signed in as {data.email}, not yet confirmed.</p>
    {/if}
    {@render resend(data.email)}
  {/if}

  {#if form?.error !== undefined}
    <p role="alert" class="error">{form.error}</p>
  {/if}
</section>

<!--
  One resend form, rendered by whichever branch needs it. Duplicated markup would be
  two places to keep a `for`/`id` pair in step, and a mismatched pair is an input
  with no accessible name — invisible to a screen reader and to this file's own
  `getByLabel` assertions.

  A POST rather than a GET: `/api/auth/send-verification-email` has a built-in limit
  of three per minute per IP, and a GET that sends mail would let a prefetcher or an
  `<img src>` exhaust another person's quota.
-->
{#snippet resend(email: string | null)}
  <form method="POST" class="resend">
    <label for="resend-email">Email</label>
    <input
      id="resend-email"
      name="email"
      type="email"
      inputmode="email"
      autocomplete="email"
      required
      value={email ?? ''}
    />
    <button type="submit">Send the link again</button>
  </form>
{/snippet}

<style>
  .lede {
    color: var(--color-text-muted);
  }

  .resend {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: var(--space-3);
    margin-block-start: var(--space-4);
  }

  .error {
    color: var(--color-danger, #b3261e);
  }
</style>
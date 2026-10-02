<!--
  Set a new password, from a link in an email.

  The token is in the URL's query string and is never put in the form's `action`:
  with `method="POST"` and no action, the browser posts to the current URL, so the
  token is used without being rendered into the HTML. That matters because this page
  is reachable by anyone holding the link, and a token echoed into a cached or
  screenshotted DOM outlives the password it protects.

  Three outcomes, three messages:
    `sent`       the address may or may not exist; say so either way.
    no token     the link is gone. Offer a new one.
    a token      a usable link.
-->
<script lang="ts">
import type { ActionData, PageData } from './$types';

let { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<section id="reset-password-screen" aria-labelledby="reset-heading">
  <h1 id="reset-heading">Choose a new password</h1>

  {#if data.sent}
    <p role="status">
      If that address has an account, a link is on its way. It works once and
      expires in an hour.
    </p>
    <p><a href="/login">Back to sign in</a></p>
  {:else if !data.hasToken}
    <p role="alert">
      That link is no longer valid. It may have expired, or it may already have
      been used.
    </p>
    <p><a href="/forgot-password">Ask for a new link</a></p>
  {:else}
    {#if data.email !== null}
      <p class="lede">For {data.email}.</p>
    {/if}

    <form method="POST">
      <div class="field">
        <label for="new-password">New password</label>
        <input
          id="new-password"
          name="newPassword"
          type="password"
          autocomplete="new-password"
          required
          aria-describedby="new-password-hint{form?.errors?.newPassword === undefined
            ? ''
            : ' new-password-error'}"
          aria-invalid={form?.errors?.newPassword === undefined ? undefined : 'true'}
        />
        <p id="new-password-hint" class="hint">At least 8 characters.</p>
        {#if form?.errors?.newPassword !== undefined}
          <p id="new-password-error" class="error" role="alert">{form.errors.newPassword}</p>
        {/if}
      </div>

      <button type="submit">Save the new password</button>
    </form>
  {/if}
</section>

<style>
  .lede {
    color: var(--color-text-muted);
  }

  .hint {
    color: var(--color-text-muted);
    font-size: var(--font-size-sm);
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-block-end: var(--space-4);
    max-width: 24rem;
  }

  .error {
    color: var(--color-danger, #b3261e);
  }
</style>
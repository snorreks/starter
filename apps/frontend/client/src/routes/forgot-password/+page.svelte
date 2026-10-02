<!--
  Ask for a recovery email.

  One field and one button. No ViewModel: there is no screen state beyond "the
  server has answered", and that answer is already in `form`.
-->
<script lang="ts">
import type { ActionData } from './$types';

let { form }: { form: ActionData } = $props();
</script>

<section id="forgot-password-screen" aria-labelledby="forgot-heading">
  <h1 id="forgot-heading">Reset your password</h1>

  <p class="lede">
    Enter the address you signed up with. If it has an account, a link to choose a
    new password is on its way.
  </p>

  <form method="POST">
    <div class="field">
      <label for="recovery-email">Email</label>
      <input
        id="recovery-email"
        name="email"
        type="email"
        inputmode="email"
        autocomplete="email"
        required
        aria-describedby={form?.errors?.email === undefined ? undefined : 'recovery-email-error'}
        aria-invalid={form?.errors?.email === undefined ? undefined : 'true'}
      />
      {#if form?.errors?.email !== undefined}
        <p id="recovery-email-error" class="error">{form.errors.email}</p>
      {/if}
    </div>

    {#if form?.message !== undefined}
      <p class="error" role="alert">{form.message}</p>
    {/if}

    <button type="submit">Send the link</button>
  </form>

  <p class="secondary">
    <a href="/login">Back to sign in</a>
  </p>
</section>

<style>
  .lede {
    color: var(--color-text-muted);
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

  .secondary {
    margin-block-start: var(--space-4);
  }
</style>
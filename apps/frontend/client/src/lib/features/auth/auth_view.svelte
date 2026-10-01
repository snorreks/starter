<!--
  Sign-in / sign-up.

  A View with a real accessibility contract: every input has a `<label>`, the
  form-level error is announced with `role="alert"`, the submit button exposes
  its busy state, and the password field is not autofilled in a way that fights
  a password manager.
-->
<script lang="ts">
import { Field } from '@starter/ui';
import type { AuthViewModel } from './auth_view_model.svelte.ts';

type Props = { viewModel: AuthViewModel };
let { viewModel }: Props = $props();
</script>

<form
  class="auth"
  onsubmit={(event) => {
    event.preventDefault();
    void viewModel.handleSubmit();
  }}
  data-testid="auth-form"
  novalidate
>
  <h1 class="auth__title">
    {viewModel.mode === 'sign-in' ? 'Sign in' : 'Create an account'}
  </h1>

  <Field id="auth-email" label="Email" required error={viewModel.errors.email}>
    {#snippet children({ id, describedBy, invalid })}
      <input
        {id}
        class="auth__input"
        type="email"
        autocomplete="email"
        value={viewModel.form.email}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        oninput={(event) => (viewModel.form.email = event.currentTarget.value)}
        data-testid="auth-email-input"
      />
    {/snippet}
  </Field>

  <Field
    id="auth-password"
    label="Password"
    required
    error={viewModel.errors.password}
    hint={viewModel.mode === 'sign-up' ? 'At least 8 characters.' : undefined}
  >
    {#snippet children({ id, describedBy, invalid })}
      <input
        {id}
        class="auth__input"
        type="password"
        autocomplete={viewModel.mode === 'sign-in' ? 'current-password' : 'new-password'}
        value={viewModel.form.password}
        aria-describedby={describedBy}
        aria-invalid={invalid}
        oninput={(event) => (viewModel.form.password = event.currentTarget.value)}
        data-testid="auth-password-input"
      />
    {/snippet}
  </Field>

  {#if viewModel.serverMessage}
    <p class="auth__server-error" role="alert" data-testid="auth-error">
      {viewModel.serverMessage}
    </p>
  {/if}

  <button
    type="submit"
    class="ui-button ui-button--primary auth__submit"
    disabled={viewModel.isSubmitting}
    aria-busy={viewModel.isSubmitting}
    data-testid="auth-submit"
  >
    {viewModel.isSubmitting
      ? 'Working…'
      : viewModel.mode === 'sign-in'
        ? 'Sign in'
        : 'Create account'}
  </button>

  <button
    type="button"
    class="auth__toggle"
    onclick={() => viewModel.toggleMode()}
    data-testid="auth-toggle-mode"
  >
    {viewModel.mode === 'sign-in'
      ? 'No account? Create one'
      : 'Already registered? Sign in'}
  </button>
</form>

<style>
  .auth {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-width: 24rem;
    margin: var(--space-7) auto;
    padding: var(--space-5);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    background: var(--color-surface);
    box-shadow: var(--shadow-sm);
  }

  .auth__title {
    font-size: var(--font-size-xl);
    line-height: var(--line-height-tight);
  }

  .auth__input {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border-strong);
    border-radius: var(--radius-sm);
    background: var(--color-canvas);
    color: var(--color-text);
    font: inherit;
  }

  .auth__input[aria-invalid='true'] {
    border-color: var(--color-danger);
  }

  .auth__server-error {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-danger-border);
    border-radius: var(--radius-sm);
    background: var(--color-danger-subtle);
    color: var(--color-danger-text);
    font-size: var(--font-size-sm);
  }

  .auth__submit {
    margin-top: var(--space-1);
  }

  .auth__toggle {
    background: none;
    border: none;
    padding: 0;
    color: var(--color-accent-text);
    font: inherit;
    font-size: var(--font-size-sm);
    text-decoration: underline;
    cursor: pointer;
  }
</style>

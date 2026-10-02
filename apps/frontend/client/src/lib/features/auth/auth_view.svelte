<!--
  apps/frontend/client/src/lib/features/auth/auth_view.svelte

  Sign-in, sign-up, and the states either of those can end in.

  Semantic HTML with no ARIA on the happy path. A `<form>` submits on Enter, gets
  focus order for free, and is announced correctly; a div with `onclick` needs all
  of that re-added by hand and usually gets one of them wrong.

  Two accessibility decisions worth stating, because both are easy to get subtly
  wrong:

  - The message is a live region with `role="alert"`, so it is announced when it
    appears. It is *not* `aria-live` on a container that is always in the DOM:
    that announces the container on load and nothing when the content changes.
  - Focus moves to the first invalid field on a failed submission. Reporting an
    error without moving focus means a keyboard or screen-reader user is told
    something is wrong and left where they were.

  No ViewModel is required for either link or either field. They are two links and
  two inputs with no state of their own, and giving them one would be a layer with
  nothing to do.
-->
<script lang="ts">
import { Field } from '@starter/ui';
import type { AuthViewModel } from './auth_view_model.svelte.ts';

type Props = {
  viewModel: AuthViewModel;
  /** Errors from the last submission, keyed by field. */
  errors: Record<string, string>;
};

let { viewModel, errors }: Props = $props();

const errorFor = (field: string): string | undefined => errors[field];
</script>

<section id="auth-screen" aria-labelledby="auth-heading">
  <h2 id="auth-heading">
    {viewModel.isSignUp ? 'Create your account' : 'Sign in'}
  </h2>

  <p class="auth__lede">
    {viewModel.isSignUp
      ? 'You will confirm your address before the account is usable.'
      : 'Your notes are private to your account.'}
  </p>

  <!--
    `data-testid` values here are a contract with `apps/e2e/tests/`, which drives
    this form through a real browser. They are `id`-independent on purpose: an
    `aria-labelledby` or a `for` attribute would tie a test to the accessibility
    wiring, and a refactor that preserved the wiring but renamed the id would then
    break every end-to-end test for no reason a user could name.
  -->
  <!--
    `intent` is a real form field, and the mode switch below is a submitter that posts
    its own `toggle` field. The form action reads `toggle` before it reads anything else,
    because that is the one request that is not a submission: handling it as a sign-in
    would be a side effect of asking to switch modes.
  -->
  <form
    id="auth-form"
    method="POST"
    data-testid="auth-form"
    onsubmit={(event) => {
      // With scripting, the ViewModel owns the submission. Without it, the browser posts
      // to the same route's action and the server-rendered response comes back.
      event.preventDefault();
      void viewModel.handleSubmit(event.currentTarget, event.submitter);
    }}
  >
    <input type="hidden" name="intent" value={viewModel.mode} />
    {#if viewModel.isSignUp}
      <Field label="Name" id="auth-name" error={errorFor('displayName')}>
        {#snippet children({ id, describedBy, invalid })}
          <input
            {id}
            aria-describedby={describedBy}
            aria-invalid={invalid}
            name="name"
            data-testid="auth-name-input"
            autocomplete="name"
            required
            value={viewModel.form.displayName}
            oninput={(event) => (viewModel.form.displayName = event.currentTarget.value)}
          />
        {/snippet}
      </Field>
    {/if}

    <Field label="Email" id="auth-email" error={errorFor('email')}>
      {#snippet children({ id, describedBy, invalid })}
        <input
          {id}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          name="email"
          data-testid="auth-email-input"
          type="email"
          inputmode="email"
          autocomplete="email"
          required
          value={viewModel.form.email}
          oninput={(event) => (viewModel.form.email = event.currentTarget.value)}
        />
      {/snippet}
    </Field>

    <Field
      label="Password"
      id="auth-password"
      error={errorFor('password')}
      hint={viewModel.isSignUp ? 'At least 8 characters.' : undefined}
    >
      {#snippet children({ id, describedBy, invalid })}
        <input
          {id}
          aria-describedby={describedBy}
          aria-invalid={invalid}
          name="password"
          data-testid="auth-password-input"
          type="password"
          autocomplete={viewModel.isSignUp ? 'new-password' : 'current-password'}
          required
          value={viewModel.form.password}
          oninput={(event) => (viewModel.form.password = event.currentTarget.value)}
        />
      {/snippet}
    </Field>

    <!--
      `role="alert"` rather than `aria-live="polite"` on a permanent container: a live
      region that is present at load is not reliably announced when only its text
      changes, and this is the one message on the screen that has to reach a screen
      reader the moment it appears.

      Rendered even when empty — `role="alert"` needs the element to be in the
      accessibility tree before it changes, and a conditionally-inserted live region is
      the version that browsers most often miss.
    -->
    <p class="auth__message" role="alert" data-testid="auth-error">
      {#if viewModel.message}
        {viewModel.message}
      {/if}
    </p>

    <div class="auth__actions">
      <button type="submit" data-testid="auth-submit" disabled={viewModel.isSubmitting}>
        {viewModel.isSubmitting ? 'Working…' : viewModel.isSignUp ? 'Create account' : 'Sign in'}
      </button>

      {#if viewModel.canResendVerification}
        <button
          type="button"
          class="auth__link"
          data-testid="auth-resend-verification"
          disabled={viewModel.isSubmitting}
          onclick={() => void viewModel.resendVerification()}
        >
          Send the confirmation link again
        </button>
      {/if}
    </div>
  </form>

  <nav class="auth__secondary" aria-label="Other account options">
    <!--
      A submit button associated with the form, not a `button` with an `onclick`.
      `form="auth-form"` makes it a *submitter*, which is the only button a browser can
      post as — so with scripting disabled this still reaches the sign-up form, and with
      scripting enabled the `onsubmit` handler reads the submitter and switches mode
      without a round trip.

      Its own name is `toggle`, and that is what the payload carries: the button posts
      `toggle=` alongside the form's fields, and nothing else does. It deliberately does
      *not* reuse the form's `intent` field, because a submitter does not replace a field
      of the same name — the browser puts both in the payload, and `FormData.get` returns
      the first. Overloading `intent` here would make the toggle arrive as `intent=sign-in`,
      which is a sign-in submission performed by someone who asked for the sign-*up* form.

      `formnovalidate` is not optional. The browser refuses to submit a form whose
      constraints are unsatisfied, and this button is the one that gets pressed
      precisely when the form is *empty* — that is the state someone switches modes
      from. Without it, pressing this button validates two empty required fields, finds
      them invalid, and fires no `submit` event at all: the mode switch silently does
      nothing, in a browser and only in a browser, which is the worst possible place for
      it to be broken.
    -->
    <button
      type="submit"
      form="auth-form"
      formnovalidate
      name="toggle"
      class="auth__link"
      data-testid="auth-toggle-mode"
    >
      {viewModel.isSignUp ? 'I already have an account' : 'I need an account'}
    </button>
    <a href="/forgot-password">Forgot your password?</a>
  </nav>
</section>

<style>
  .auth__lede {
    color: var(--color-text-muted);
  }

  .auth__message {
    min-height: 1.5rem;
    margin-block: var(--space-2);
    color: var(--color-danger, #b3261e);
  }

  .auth__actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }

  .auth__secondary {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4);
    margin-block-start: var(--space-4);
  }

  .auth__link {
    background: none;
    border: none;
    padding: 0;
    color: var(--color-accent, inherit);
    text-decoration: underline;
    cursor: pointer;
  }

  .auth__link:disabled {
    cursor: progress;
  }
</style>
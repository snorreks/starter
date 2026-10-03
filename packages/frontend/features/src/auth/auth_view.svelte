<!--
  packages/frontend/features/src/auth/auth_view.svelte

  Sign-in, sign-up, and the states either of those can end in.

  Semantic HTML supplies form submission and keyboard order. Field components
  associate labels and errors with inputs. The submission message uses
  `role="alert"` so assistive technology can announce it.

  AuthViewModel owns the screen state; individual fields and links do not need
  separate ViewModels.

  `progressive` is the one host difference, and it is a prop rather than a fork
  ---------------------------------------------------------------------
  With `progressive`, the form posts to a server action and the mode switch is a
  submitter carrying its own `toggle` field — so a browser with scripting disabled
  can still sign in, sign up and switch modes. Those are properties of a *server
  action*, which is a SvelteKit concept this file does not own.

  Without it, the same fields and the same ViewModel drive the screen, and the mode
  switch is a plain button. A host with no server actions gets nothing that looks
  like one: a `method="POST"` form would navigate to a URL that cannot answer, and
  a `toggle` submitter would post a field nobody reads. So the difference is one
  boolean the composition root states, rather than two copies of this component that
  drift apart.
-->
<script lang="ts">
import { Field } from '@starter/ui';
import type { AuthViewModel } from './auth_view_model.svelte.ts';

type Props = {
  viewModel: AuthViewModel;
  /** Errors from the last submission, keyed by field. */
  errors: Record<string, string>;
  /** True when a server form action can handle a submission with no scripting. */
  progressive?: boolean;
};

let { viewModel, errors, progressive = false }: Props = $props();

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
    `intent` is a real form field, and in the progressive case the mode switch
    below is a submitter that posts its own `toggle` field. The form action reads
    `toggle` before it reads anything else, because that is the one request that is
    not a submission: handling it as a sign-in would be a side effect of asking to
    switch modes.
  -->
  <form
    id="auth-form"
    method={progressive ? 'POST' : undefined}
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
      A submit button associated with the form, not a `button` with an `onclick` —
      in the progressive case. `form="auth-form"` makes it a *submitter*, which is
      the only button a browser can post as — so with scripting disabled this still
      reaches the sign-up form, and with scripting enabled the `onsubmit` handler
      reads the submitter and switches mode without a round trip.

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

      Without a server action there is no `toggle` field for a submitter to carry and
      nothing would read it, so the same switch is a plain button there. One control,
      two hosts, and the difference is the boolean rather than a second component.
    -->
    {#if progressive}
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
    {:else}
      <button
        type="button"
        class="auth__link"
        data-testid="auth-toggle-mode"
        onclick={() => viewModel.toggleMode()}
      >
        {viewModel.isSignUp ? 'I already have an account' : 'I need an account'}
      </button>
    {/if}
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
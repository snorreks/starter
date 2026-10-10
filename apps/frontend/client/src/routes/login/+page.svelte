<!--
  The sign-in screen.

  Two of this route's inputs come from the server and two do not:

    `data.user`        the layout load's verified identity. Already resolved, so
                       the redirect below costs no extra session lookup.
    `data.mode`/`email` which form to render and what to pre-fill it with.
    `form.errors`      field errors from a form action, after a non-JS submit.
    `form.outcome`     the action's outcome, e.g. "check your inbox".

  The `ViewModel` is constructed once and its `errors`/`outcome` are *replaced*
  whenever a new submission arrives, not merged. Merging is how a stale error for a
  field the user has since fixed survives into the next attempt.

  The server-rendered content is what the user sees before hydration and after it.
  Nothing here fetches on mount.
-->
<script lang="ts">
import { type AuthOutcome, AuthView } from '@starter/features/auth';
import { untrack } from 'svelte';
import { getAuthViewModel } from '#lib/composition/auth.ts';
import { goto } from '$app/navigation';
import type { PageData } from './$types';

let { data, form }: { data: PageData; form: ActionData } = $props();

// `progressive` is the whole of this route's difference from the shared view: this
// route *has* a form action, so the form posts to it when scripting is off and the
// mode switch is the `toggle` submitter that action reads. A host with no action
// renders the same component without it.
const viewModel = getAuthViewModel({
  // Read untracked, because this is the *initial* mode and not a live binding. The
  // server owns which mode is rendered — the mode switch is a form submission, and a
  // submission comes back as a page — so the first render must already be right, and
  // `$effect` below would not run during SSR at all.
  //
  // The effect exists for the other half: a client-side navigation between the two
  // modes reuses this component, and without it the form would stay on whichever mode
  // was current when the component was first created.
  mode: untrack(() => data.mode),
  // Seeded at construction, not in an effect, because `$effect` does not run during
  // SSR — so an effect-seeded value renders as empty on the server and correct after
  // hydration. That is a visible flash of an empty field on a screen whose whole point
  // is not losing what was typed.
  email: untrack(() => data.email),
});

$effect(() => {
  viewModel.mode = data.mode;
});

// A form action's result and a client submission write to the same two fields, so
// there is one place that decides what the view shows and no second path that can
// disagree with it.
//
// Assigned here as well as in the effect, and that duplication is the point: `$effect`
// does not run during SSR, so an effect-only assignment renders a sign-up that the
// action accepted as a blank form. The browser that gets here without running a script
// has nothing else to read it from — the response it already has *is* the result.
//
// `untrack` because the initial value is exactly what is wanted, the same reason
// `mode` and `email` above are read untracked. Without it the compiler warns that a
// prop is captured once, which is true and is the design; with it the warning goes
// and the intent is stated instead of inferred.
const seeded = untrack(() => form);
if (seeded?.errors !== undefined) {
  viewModel.errors = seeded.errors;
}
if (seeded?.outcome !== undefined) {
  viewModel.outcome = seeded.outcome;
}

// The action echoes what was submitted so a refused no-JS submit does not come back as
// an empty form. `load` cannot do this: a POST result re-renders at the same URL, with
// no query to read a typed address back out of.
if (seeded?.values?.email !== undefined) {
  viewModel.form.email = seeded.values.email;
}
if (seeded?.values?.displayName !== undefined) {
  viewModel.form.displayName = seeded.values.displayName;
}

$effect(() => {
  viewModel.errors = form?.errors ?? {};
  viewModel.outcome = form?.outcome ?? undefined;
});

// A signed-in visitor has no business on the sign-in form.
$effect(() => {
  if (data.user !== null) {
    void goto('/notes');
  }
});

/**
 * The action's return value.
 *
 * Typed as `AuthOutcome` rather than `{ kind: string }` so a mismatch between the
 * action and the ViewModel is a compile error here, not a runtime blank message.
 */
type ActionData = {
  errors?: Record<string, string>;
  outcome?: AuthOutcome;
  /** Echoed back from a refused submit, so a no-JS retry is not an empty form. */
  values?: { email?: string; displayName?: string };
} | null;
</script>

{#if data.user === null}
  <AuthView {viewModel} errors={viewModel.errors} progressive />

  <!--
    A separate form, not a second submitter inside AuthView's: that component owns
    its form element, and the shared view should not grow a control that only one
    host has. Posting to this route's default action is the same path the sign-in
    form takes, so it also works with scripting off.
  -->
  {#if data.seededAccount}
    <form method="POST" class="auth__secondary">
      <button
        type="submit"
        class="auth__link"
        name="intent"
        value={data.seededAccount.intent}
        data-testid="auth-use-seeded-account"
      >
        Sign in as the seeded development account
      </button>
    </form>
  {/if}
{/if}
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
import { untrack } from 'svelte';
import { type AuthOutcome, AuthView, getAuthViewModel } from '#lib/features/auth';
import { goto, invalidateAll } from '$app/navigation';
import type { PageData } from './$types';

let { data, form }: { data: PageData; form: ActionData } = $props();

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
  navigate: async (path) => {
    // After a successful sign-in the server has to re-render: the layout load
    // carries the user, and `/notes` redirects on its own load. A client-side `goto`
    // alone would navigate to a page whose server load runs against the session the
    // browser already has.
    await invalidateAll();
    await goto(path);
  },
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
if (form?.errors !== undefined) {
  viewModel.errors = form.errors;
}
if (form?.outcome !== undefined) {
  viewModel.outcome = form.outcome;
}

// The action echoes what was submitted so a refused no-JS submit does not come back as
// an empty form. `load` cannot do this: a POST result re-renders at the same URL, with
// no query to read a typed address back out of.
if (form?.values?.email !== undefined) {
  viewModel.form.email = form.values.email;
}
if (form?.values?.displayName !== undefined) {
  viewModel.form.displayName = form.values.displayName;
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
  <AuthView {viewModel} errors={viewModel.errors} />
{/if}
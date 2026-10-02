<script lang="ts">
import { AuthView } from '#lib/features/auth';
import { getAuthViewModel } from '#lib/features/auth/auth_composition';
import { goto, invalidateAll } from '$app/navigation';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();

const viewModel = getAuthViewModel({
  // After a successful sign-in the server has to re-render: the layout load
  // carries the user, and `/notes` redirects on its own load. A client-side
  // `goto` alone would navigate to a page whose server load runs against the
  // session the browser already has, which happens to work — and would not, if
  // the sign-in had set anything the server had not seen.
  navigate: async (path) => {
    await invalidateAll();
    await goto(path);
  },
});

// A signed-in visitor has no business on the sign-in form. Redirecting here
// rather than in a load keeps the check in one place; the layout load already
// resolved the identity, so this is not a second session lookup.
$effect(() => {
  if (data.user !== null) {
    void goto('/notes');
  }
});
</script>

{#if data.user === null}
  <AuthView {viewModel} />
{/if}

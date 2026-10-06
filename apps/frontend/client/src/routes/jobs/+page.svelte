<!--
  The jobs route.

  A route page owns exactly one thing: constructing the ViewModel and handing it to
  the view. The list and the scheduler evidence arrive from `+page.server.ts`,
  rendered into the HTML from the same jobs service the API uses, so the first
  paint already has the data and the browser does not immediately fetch it again.

  Two properties worth naming:

    * **No duplicate initial fetch.** The ViewModel is *seeded* rather than
      initialized empty, so mounting it does not re-request the list it was just
      given. See `getJobsViewModel`.
    * **A disabled profile costs nothing.** The load reports the capability, the
      ViewModel starts in its unavailable state, and no request is made — the
      screen says "switched off here" instead of rendering an error and then
      discovering there is nothing to retry.

  The visibility wiring is the other half of the lifecycle: a hidden tab is not
  polled, and a tab that comes back refreshes once. It lives here rather than in
  the feature because "is this window visible" is a host fact, and a shared
  ViewModel that asked would need a capability it does not have.
-->
<script lang="ts">
import { JobsView } from '@starter/features/jobs';
import { untrack } from 'svelte';
import { getJobsViewModel } from '#lib/composition/jobs.ts';
import type { PageData } from './$types';

let { data }: { data: PageData } = $props();

// Created once and seeded with what the server rendered. `untrack` says "the
// value right now": reading `data.jobs` bare here would be flagged as a reactive
// read captured outside a closure, and the usual fix — moving it into an effect —
// would be wrong, because an effect does not run during the server render.
//
// `data.profile` is read untracked for the same reason. It is the *deployment*
// mode the server already resolved, not a live binding: the capability cannot
// change while this page is mounted, and a tracked read here would both warn and
// imply a liveness the value does not have. The effect below re-reads it on
// navigation, where re-running is the intent.
const viewModel = getJobsViewModel(
  untrack(() => data.profile) === 'disabled'
    ? {
        unavailableMessage:
          'This deployment has the jobs profile disabled, so jobs cannot be started or listed here.',
      }
    : {
        initialJobs: untrack(() => data.jobs),
        initialMaintenance: untrack(() => data.maintenance),
      },
);

// A client-side navigation re-runs the load and hands this component new data.
$effect(() => {
  if (data.profile === 'disabled') {
    return;
  }
  const { jobs, maintenance } = data;
  untrack(() => viewModel.seed(jobs, maintenance));
});

// Visibility, through the window's own document. `document` is browser-only, and
// this effect runs in the browser only — an effect does not run during SSR.
$effect(() => {
  const onVisibility = (): void => {
    viewModel.setActive(document.visibilityState === 'visible');
  };

  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    viewModel.setActive(true);
  };
});
</script>

<svelte:head>
  <title>Your jobs — Starter</title>
</svelte:head>

<JobsView {viewModel} />

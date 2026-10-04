<script lang="ts">
// The native jobs route.
//
// The same screen, the same ViewModel and the same service the web application
// renders — the only difference in this file is which transport is behind them and
// that activity comes from the shell rather than from `document` alone.
//
// There is no `+page.server.ts` here, and the reason is the same as the notes
// route: this app is prerendered, so there is no server render that could seed the
// list. This window holds a bearer token it must present itself, so the first read
// happens after mount rather than arriving with the HTML.
//
// Activity is wired from `#lib/platform/app_activity.ts` rather than from
// `visibilitychange` alone: a window behind another one still reports itself
// visible, and a screen that polls for a user who cannot see it is the battery
// failure that gets an app killed on a phone.
import { JobsView } from '@starter/features/jobs';
import { getJobsViewModel } from '#lib/composition/jobs.ts';
import { watchAppActivity } from '#lib/platform/app_activity.ts';

const viewModel = getJobsViewModel();

$effect(() => {
  const stopWatching = watchAppActivity((active) => viewModel.setActive(active));
  return stopWatching;
});
</script>

<svelte:head>
  <title>Sample encode — Starter</title>
</svelte:head>

<JobsView {viewModel} />

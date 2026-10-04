<!--
  The jobs screen.

  A View's job is markup, accessibility, DOM interaction and small presentation
  state. Everything else — the list, the poll, the refusal, the held result — is in
  the ViewModel, and the same one renders in the web application and in a native
  window.

  What this screen deliberately does not render
  ---------------------------------------------
  A progress percentage, a queue position, an estimated time, a sparkline of
  "compute used". The job contract carries four states, two timestamps and one
  availability flag; anything more precise than that would be a number invented in
  the browser. The one piece of operational evidence it does show is the
  maintenance record, and it shows the *trigger* with it — a scheduled run and a
  manual run are different facts and a screen that showed only the timestamp would
  report a hand-pressed button as the schedule firing.

  Accessibility
  -------------
  The status line is a live region so a screen reader hears "Encoding" without the
  user hunting for it, refusals are `role="alert"` because they are the answer to
  something the user just pressed, and the player carries a label. The `unavailable`
  state has no retry button, because retrying a capability that is switched off
  cannot help.
-->
<script lang="ts">
import type { JobDto } from '@starter/schemas/jobs';
import { EmptyState, ErrorState, ScreenContainer, Spinner } from '@starter/ui';
import JobRow from './job_row.svelte';
import type { JobsViewModel } from './jobs_view_model.svelte.ts';

type Props = {
  viewModel: JobsViewModel;
  /** Mints the idempotency key for one create attempt. Injected for tests. */
  newIdempotencyKey?: () => string;
};

let { viewModel, newIdempotencyKey = () => crypto.randomUUID() }: Props = $props();

/** The job whose bytes are being fetched, so one row can say "Loading result…". */
let loadingOutputFor = $state<string | null>(null);

const maintenanceText = $derived.by(() => {
  const latest = viewModel.maintenance;
  if (latest === null) {
    return null;
  }
  if (latest.latestScheduled !== null) {
    const run = latest.latestScheduled;
    const when = run.scheduledTime === null ? run.slot : new Date(run.scheduledTime).toISOString();
    return `Last scheduled maintenance: ${when}, ${run.status}.`;
  }
  if (latest.latest !== null) {
    // The honest sentence, and the one this field exists to produce: a deployment
    // that has only ever been swept by hand has not demonstrated its schedule.
    return `No scheduled maintenance run yet. The most recent run was started manually and ${latest.latest.status}.`;
  }
  return 'No maintenance run has been recorded yet.';
});

async function startEncode(): Promise<void> {
  await viewModel.startEncode(newIdempotencyKey());
}

async function loadOutput(jobId: string): Promise<void> {
  loadingOutputFor = jobId;
  try {
    await viewModel.loadOutput(jobId);
  } finally {
    loadingOutputFor = null;
  }
}

/**
 * Save the held result, through the object URL this ViewModel already owns.
 *
 * A click on a synthetic anchor rather than `window.open`: the URL is a Blob the
 * screen created, so nothing leaves the origin and no credential is in it. The
 * anchor is removed immediately — leaving it in the document is a second
 * reference to a Blob the disposal path is about to revoke.
 */
function downloadOutput(): void {
  const output = viewModel.output;
  if (output === null) {
    return;
  }
  const anchor = document.createElement('a');
  anchor.href = output.url;
  anchor.download = output.filename;
  anchor.rel = 'noopener';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

const statusLabel = (job: JobDto): string => job.status;
</script>

<ScreenContainer screen={viewModel} element="section" id="jobs-screen">
  <header class="jobs__header">
    <div>
      <h1 class="jobs__title">Sample encode</h1>
      <p class="jobs__subtitle">
        One short sample is encoded on demand. The result is yours alone, and it is removed 24 hours
        after it is finished.
      </p>
    </div>

    <button
      type="button"
      class="ui-button ui-button--primary"
      data-testid="jobs-start"
      disabled={viewModel.starting || viewModel.status.kind !== 'ready' || viewModel.hasActiveJob}
      aria-busy={viewModel.starting}
      onclick={() => void startEncode()}
    >
      {viewModel.starting ? 'Starting…' : 'Encode sample'}
    </button>
  </header>

  <!--
    The live region. It is rendered even when nothing has happened yet, because a
    region that appears with its text announces nothing.
  -->
  <p class="jobs__live" role="status" aria-live="polite" data-testid="jobs-live">
    {#if viewModel.refreshing}
      Checking your jobs…
    {:else if viewModel.activeJob !== null}
      {statusLabel(viewModel.activeJob)} — this screen checks again while it changes.
    {:else if viewModel.jobs.length > 0}
      All of your jobs have finished. This screen has stopped checking.
    {/if}
  </p>

  {#if viewModel.refusal !== null}
    <p class="jobs__refusal" role="alert" data-testid="jobs-refusal">
      {viewModel.refusal.message}
    </p>
  {/if}

  <div class="jobs__body">
    {#if viewModel.status.kind === 'loading'}
      <div class="jobs__loading" role="status" aria-live="polite">
        <Spinner />
        <span>Loading jobs…</span>
      </div>
    {:else if viewModel.status.kind === 'unavailable'}
      <!--
        No `onRetry`: the capability is switched off for this deployment, so a
        "Try again" button here would be a control that cannot do anything.
      -->
      <ErrorState
        title="Jobs are switched off here"
        message={viewModel.status.message}
        retryable={false}
        testId="jobs-unavailable"
      />
    {:else if viewModel.status.kind === 'error'}
      <ErrorState
        title="Could not load your jobs"
        message={viewModel.status.message}
        retryable={viewModel.status.retryable}
        onRetry={() => void viewModel.load()}
        testId="jobs-error"
      />
    {:else if viewModel.isEmpty}
      <EmptyState
        title="No jobs yet"
        body="Encode the sample above. It takes a few seconds and shows up here as soon as the server accepts it."
        testId="jobs-empty"
      />
    {:else}
      <ul class="jobs__list" data-testid="jobs-list">
        {#each viewModel.jobs as job (job.id)}
          <JobRow
            {job}
            loadedJobId={viewModel.output?.jobId ?? null}
            loadingOutput={loadingOutputFor === job.id}
            onLoadOutput={(jobId) => void loadOutput(jobId)}
            onDownload={downloadOutput}
          />
        {/each}
      </ul>
    {/if}
  </div>

  {#if maintenanceText !== null}
    <footer class="jobs__maintenance" data-testid="jobs-maintenance">
      {maintenanceText}
      {#if viewModel.maintenance !== null && viewModel.maintenance.schedule !== null}
        <span class="jobs__schedule">Schedule: {viewModel.maintenance.schedule} UTC</span>
      {/if}
    </footer>
  {/if}

  {#if viewModel.output !== null}
    <section class="jobs__player" data-testid="jobs-player" aria-label="Encoded sample">
      <!--
        No `<track kind="captions">`, and this is the one place a warning is
        silenced rather than answered. The artifact is a three-second synthetic
        clip generated by `starter-media fixture`: it has no speech, so a caption
        file would be an empty document presented as accessibility. What a real
        video product needs here is the WebVTT track its own content carries —
        which is a property of the media, not of this screen.
      -->
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        class="jobs__video"
        controls
        muted
        playsinline
        preload="metadata"
        data-testid="jobs-video"
        aria-label="The encoded sample result"
        src={viewModel.output.url}
      ></video>
      <p class="jobs__player-meta" data-testid="jobs-output-meta">
        {viewModel.output.filename} · {(viewModel.output.bytes / 1024).toFixed(0)} KiB · loaded
        through your signed-in session, not a link
      </p>
    </section>
  {/if}

  {#if viewModel.outputError !== null}
    <p class="jobs__refusal" role="alert" data-testid="jobs-output-error">{viewModel.outputError}</p>
  {/if}
</ScreenContainer>

<style>
  .jobs__header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  .jobs__title {
    font-size: var(--font-size-2xl);
    line-height: var(--line-height-tight);
  }

  .jobs__subtitle {
    margin-top: var(--space-1);
    /* A narrow window wraps the sentence rather than pushing the layout sideways. */
    max-width: 34rem;
    color: var(--color-text-muted);
    font-size: var(--font-size-sm);
  }

  .jobs__live {
    margin-top: var(--space-3);
    min-height: 1.25rem;
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
  }

  .jobs__refusal {
    margin-top: var(--space-3);
    padding: var(--space-3);
    border: 1px solid var(--color-danger-border);
    border-radius: var(--radius-sm);
    background: var(--color-danger-subtle);
    color: var(--color-danger-text);
    font-size: var(--font-size-sm);
  }

  .jobs__body {
    margin-top: var(--space-4);
  }

  .jobs__loading {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: 6rem;
    color: var(--color-text-muted);
  }

  .jobs__list {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .jobs__maintenance {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin-top: var(--space-5);
    padding-top: var(--space-3);
    border-top: 1px solid var(--color-border);
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
  }

  .jobs__schedule {
    font-family: ui-monospace, monospace;
  }

  .jobs__player {
    margin-top: var(--space-4);
  }

  .jobs__video {
    display: block;
    width: 100%;
    /* Intrinsic ratio preserved by the element's own defaults; the cap keeps a
       small sample from filling a desktop window. */
    max-width: 320px;
    height: auto;
    background: var(--color-surface-subtle);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
  }

  .jobs__player-meta {
    margin-top: var(--space-2);
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
  }
</style>

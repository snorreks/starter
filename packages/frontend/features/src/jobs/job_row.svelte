<!--
  packages/frontend/features/src/jobs/job_row.svelte

  One job, as a row. Presentation only: what the row *is* comes from the DTO, and
  what may be done with it comes from raised intents.

  The status is a word, never a percentage
  ----------------------------------------
  A progress bar would need a numerator this repository does not have. The server
  reports four states and an `updatedAt`; there is no queue position, no elapsed
  estimate and no completion ratio anywhere in the job contract, and inventing one
  would be a number this screen makes up. So the row says "running" and, when it
  can, when it last changed — which is true, and which the server wrote.

  The result is offered only when `outputAvailable` is true
  -------------------------------------------------------
  A job that succeeded twenty-five hours ago still says `succeeded`; its bytes are
  gone. Rendering a Play button for it would offer a fetch that answers 410, so
  the row says the result has expired instead. That distinction is the reason
  retention is reported as a separate field rather than as a fifth status.
-->
<script lang="ts">
import type { JobDto } from '@starter/schemas/jobs';

type Props = {
  job: JobDto;
  /** The result currently loaded, if any. Matched by id so the player is one. */
  loadedJobId: string | null;
  /** True while this row's bytes are being fetched. */
  loadingOutput: boolean;
  onLoadOutput: (jobId: string) => void;
  onDownload: () => void;
};

let { job, loadedJobId, loadingOutput, onLoadOutput, onDownload }: Props = $props();

const loaded = $derived(loadedJobId === job.id);

const STATUS_TEXT: Record<JobDto['status'], string> = {
  pending: 'Waiting to start',
  running: 'Encoding',
  succeeded: 'Encoded',
  failed: 'Failed',
};

const ERROR_TEXT: Record<'encode_failed' | 'attempts_exhausted' | 'internal_error', string> = {
  encode_failed: 'The encoder could not process the sample.',
  attempts_exhausted: 'The encode was retried the maximum number of times and gave up.',
  internal_error: 'The server could not finish the job.',
};

/** `1 Oct 2026, 17:04` — absolute and locale-stable, not "3 minutes ago". */
const timestamp = (epochMs: number): string =>
  new Date(epochMs).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
</script>

<li class="job" data-testid="job-row" data-job-id={job.id} data-status={job.status}>
  <div class="job__main">
    <p class="job__status">
      <span
        class="job__badge"
        class:job__badge--running={job.status === 'running'}
        class:job__badge--ok={job.status === 'succeeded'}
        class:job__badge--failed={job.status === 'failed'}
        data-testid="job-status"
      >
        {STATUS_TEXT[job.status]}
      </span>
      <span class="job__time" data-testid="job-updated">
        Last change {timestamp(job.updatedAt)}
      </span>
    </p>

    {#if job.errorCode !== null}
      <p class="job__error" role="status" data-testid="job-error">
        {ERROR_TEXT[job.errorCode]}
      </p>
    {:else if job.status === 'succeeded' && !job.outputAvailable}
      <p class="job__error" role="status" data-testid="job-expired">
        Encoded, but the result has passed its 24-hour window and is no longer available.
      </p>
    {/if}
  </div>

  <div class="job__actions">
    {#if job.status === 'succeeded' && job.outputAvailable}
      {#if loaded}
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="job-download"
          onclick={onDownload}
        >
          Download
        </button>
      {:else}
        <button
          type="button"
          class="ui-button ui-button--secondary"
          data-testid="job-load-output"
          disabled={loadingOutput}
          aria-busy={loadingOutput}
          onclick={() => onLoadOutput(job.id)}
        >
          {loadingOutput ? 'Loading result…' : 'Load result'}
        </button>
      {/if}
    {/if}
  </div>
</li>

<style>
  .job {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
  }

  .job__main {
    min-width: 0;
    flex: 1 1 14rem;
  }

  .job__status {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
  }

  .job__badge {
    font-weight: 600;
    font-size: var(--font-size-sm);
  }

  .job__badge--running {
    color: var(--color-accent);
  }

  .job__badge--ok {
    color: var(--color-success-text);
  }

  .job__badge--failed {
    color: var(--color-danger-text);
  }

  .job__time {
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
  }

  .job__error {
    margin: var(--space-1) 0 0;
    font-size: var(--font-size-sm);
    color: var(--color-text-muted);
  }

  .job__actions {
    display: flex;
    gap: var(--space-2);
    flex: 0 0 auto;
  }
</style>

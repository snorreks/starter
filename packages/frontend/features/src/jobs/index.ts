// packages/frontend/features/src/jobs/index.ts
//
// The jobs feature's public surface.
//
// Routes import from here; the internals stay private so a screen's wiring can
// change without touching every caller.
//
// Note what is *not* here: no singleton service and no composition factory. Both
// need a transport, and which transport a host has is the host's decision — the
// web application builds one in `apps/frontend/client/src/lib/composition/jobs.ts`
// and the native shell builds a different one over the bearer transport. A shared
// factory with a default would resolve the default at module scope, which is the
// app singleton the extraction of this package removed.

export { default as JobRow } from './job_row.svelte';
export {
  browserObjectUrls,
  JOB_OUTPUT_MEDIA_TYPE,
  type JobOutputHandle,
  JobOutputRejectedError,
  type JobOutputRejection,
  MAX_JOB_OUTPUT_BYTES,
  type ObjectUrlFactory,
  outputFilename,
  takeOutputHandle,
} from './jobs_output.ts';
export {
  JobsService,
  type JobsServiceOptions,
  jobOutputPath,
  SAMPLE_ENCODE_REQUEST,
} from './jobs_service.svelte.ts';
export { default as JobsView } from './jobs_view.svelte';
export {
  JOB_POLL_BACKOFF,
  JOB_POLL_BASE_MS,
  JOB_POLL_MAX_MS,
  type JobStartRefusal,
  type JobsScreenOptions,
  type JobsStatus,
  JobsViewModel,
  type Scheduler,
  TERMINAL_JOB_STATUSES,
} from './jobs_view_model.svelte.ts';

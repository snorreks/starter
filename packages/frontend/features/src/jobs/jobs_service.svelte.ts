// packages/frontend/features/src/jobs/jobs_service.svelte.ts
//
// Transport for jobs. The only place that knows the jobs HTTP shape.
//
// Three calls, three endpoints, and every one of them validates its answer
// against the schema the server validated against:
//
//   list()        → `JobListSchema`     the owner's jobs, one page
//   create()      → `JobDtoSchema`      the admitted job, 202 or a typed refusal
//   maintenance() → `LatestMaintenanceSchema`  what the schedule last did
//
// Why `ArtifactTransport` rather than `ApiTransport`
// ------------------------------------------------
// The encoded result is bytes, not a document. `ApiTransport.request` is a JSON
// transport — it reads the body as text and parses it — so asking it for an MP4
// produces a truncated string that looks like a successful answer. The byte path
// is therefore a *separate* capability the constructor requires, which is what
// makes "this host can serve a video" a compile-time fact rather than a runtime
// surprise.
//
// What it deliberately does not do
// --------------------------------
// Hold the job list. The list lives in the ViewModel that owns the screen, and a
// second copy in the service is a second thing that can disagree with the first.
// This service is stateless apart from nothing at all: every method takes the
// caller's `AbortSignal` and returns a value or throws an `AppError`, which is
// what lets the ViewModel's guards decide what is stale and what is cancelled.

import {
  type ArtifactBytes,
  type ArtifactRequestOptions,
  type ArtifactTransport,
  parseDto,
} from '@starter/platform';
import {
  type CreateEncodeJob,
  JOB_PRESET_IDS,
  type JobDto,
  JobDtoSchema,
  JobListSchema,
  type LatestMaintenance,
  LatestMaintenanceSchema,
} from '@starter/schemas/jobs';

export interface JobsServiceOptions {
  readonly transport: ArtifactTransport;
  readonly className?: string;
}

/**
 * The one request this screen can make.
 *
 * A constant rather than a parameter, because `CreateEncodeJob` is two frozen
 * enums and the screen offers exactly one action. A `fixture` selector would be a
 * control whose every possible value is the same one.
 */
export const SAMPLE_ENCODE_REQUEST: CreateEncodeJob = Object.freeze({
  fixture: 'sample-v1',
  preset: JOB_PRESET_IDS[0],
});

/** The path the output bytes are read from. Owner-checked on the server. */
export const jobOutputPath = (jobId: string): string =>
  `/api/jobs/${encodeURIComponent(jobId)}/output`;

export class JobsService {
  readonly className: string;
  readonly #transport: ArtifactTransport;

  constructor(options: JobsServiceOptions) {
    this.className = options.className ?? 'JobsService';
    this.#transport = options.transport;
  }

  /**
   * One owner's jobs, newest first, plus the scheduler's own evidence.
   *
   * Both come from `Promise.all` rather than sequentially: they are independent
   * reads of the same environment, and a screen that renders the list a round trip
   * after the maintenance note has nothing to show for the wait.
   */
  async load(signal?: AbortSignal): Promise<{ jobs: JobDto[]; maintenance: LatestMaintenance }> {
    const options = signal === undefined ? {} : { signal };
    const [listed, maintenance] = await Promise.all([
      this.#transport.request<unknown>('/api/jobs', { method: 'GET', ...options }),
      this.#transport.request<unknown>('/api/jobs/maintenance', { method: 'GET', ...options }),
    ]);

    return {
      jobs: parseDto(JobListSchema, listed, 'a job list').jobs,
      maintenance: parseDto(LatestMaintenanceSchema, maintenance, 'the latest maintenance run'),
    };
  }

  /**
   * Ask for the sample to be encoded.
   *
   * `idempotencyKey` is required and is the caller's to generate. The server
   * answers 202 for a new job *and* for a replay of one this key already created,
   * so a client that retries after a dropped connection gets the same job rather
   * than a second one — which is why the key is generated per attempt and reused
   * across retries of that attempt, never derived from a clock.
   */
  async createEncode(idempotencyKey: string, signal?: AbortSignal): Promise<JobDto> {
    const body = await this.#transport.request<unknown>('/api/jobs', {
      method: 'POST',
      body: SAMPLE_ENCODE_REQUEST,
      headers: { 'idempotency-key': idempotencyKey },
      ...(signal === undefined ? {} : { signal }),
    });
    return parseDto(JobDtoSchema, body, 'a job');
  }

  /**
   * The bytes of one job's result.
   *
   * Read through the authenticated transport rather than handed to a `<video>` as
   * a `src`, because a native shell has no cookie jar: a media element issues its
   * own request with no header, and a long-lived credential in a query string is
   * the alternative. This way the request carries the credential in a header, the
   * answer becomes a Blob the caller owns, and nothing appears in a URL, a
   * history entry or a log line.
   *
   * The measured metadata is *not* on this method. It is `JobOutput` on the server
   * and is deliberately separate from `JobDto`; a client that wants it fetches the
   * job row, which already reports whether the bytes are still there.
   */
  async readOutput(jobId: string, options: ArtifactRequestOptions = {}): Promise<ArtifactBytes> {
    return this.#transport.fetchBytes(jobOutputPath(jobId), options);
  }
}

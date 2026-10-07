// apps/backend/jobs/src/workflows/encode_workflow.ts
//
// One encode, as four durable steps.
//
// Why steps at all
// ----------------
// A single `run` body is one unit of work: if it dies, it starts again, and if it
// succeeds, nothing recorded that it had succeeded. Splitting it into steps gives
// three properties this job actually needs:
//
//   * the attempt's *claim* is recorded before any expensive work, so a crash after
//     admission leaves a job another attempt can take rather than a job that looks
//     untouched;
//   * the encode and the store are one step, so the bytes and the metadata that
//     describes them are written together or not at all;
//   * the commit is separate and fenced, so a step that re-runs after a crash
//     cannot commit twice.
//
// What a step does *not* make true is exactly-once for anything outside D1. A
// Workflow checkpoint records that a callback returned; it says nothing about an
// FFmpeg process that was killed halfway, and nothing about a stream that failed
// three quarters of the way into R2. Every external effect below is therefore
// written to be safe to repeat:
//
//   * the container refuses concurrent encodes (`429 busy`) and the bytes are stored
//     under an attempt-scoped key, so a repeated encode overwrites its own previous
//     bytes rather than another attempt's;
//   * the commit is fenced by the repository's `active_attempt_id`, so a superseded
//     attempt's success cannot overwrite the winner;
//   * the stored object's size is read back from the bucket and the stored bytes are
//     hashed on their way in, both *before* anything is committed.
//
// The four steps
// --------------
//   admit    claim the lease. Fails closed on a job another attempt owns.
//   encode   fixture bytes in, verified bytes out, into this attempt's key.
//   commit   existence and size re-read from the bucket; then the fenced write.
//   cleanup  stop the instance; the job's other attempt keys are left to retention.
//
// Retry policy
// ------------
// Only `encode` retries, twice, because only `encode` reaches something outside
// this Worker. Everything else is a D1 write, and those writes are already
// idempotent or already fenced — retrying them would repeat a *decision*, not an
// attempt.
//
// A refusal the processor called terminal — invalid media, an unsupported preset, a
// protocol mismatch — is *returned* from the step rather than thrown, so the platform
// stops immediately instead of spending two more container starts on bytes that
// cannot possibly encode. It is returned rather than thrown because a thrown error
// loses its class across the step boundary; see `EncodeAttempt`.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { createJobRepository, type JobsDatabase, systemClock } from '@starter/jobs';
import {
  JOB_ATTEMPT_LEASE_MS,
  JOB_OUTPUT_RETENTION_MS,
  type JobStatus,
  MAX_JOB_ATTEMPTS,
} from '@starter/schemas/jobs';
import { createId } from '@starter/utils';
import { runCloudRunAttempt } from '../cloud_run/compute.ts';
import {
  type JobsEnv,
  requireJobsBindings,
  requireJobsDeploymentEnvironment,
  resolveJobsProfile,
} from '../env.ts';
import { createMediaStore, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES } from '../media_store.ts';
import { createProcessorClient } from '../processor_client.ts';

/** What the dispatcher put in the instance's parameters. */
export interface EncodeWorkflowParams {
  jobId: string;
  fixture: 'sample-v1';
  preset: 'demo-180p-v1';
  attemptId: string;
}

/**
 * Retries for the one step that leaves the Worker.
 *
 * Two, which with the first attempt is the three attempts the job budget allows —
 * the same number, deliberately: a fourth attempt would be admitted by the workflow
 * and refused by the repository, which is a container start spent to learn nothing.
 *
 * The delay is short and constant. The retryable refusals are `busy` (the other
 * instance is mid-encode) and a transport hiccup; neither benefits from exponential
 * backoff inside a step that already has a 150 s deadline around it.
 */
export const ENCODE_STEP_RETRIES = 2;

/** The delay between encode attempts. */
export const ENCODE_STEP_RETRY_DELAY_MS = 2_000;

/**
 * The wall-clock ceiling for the encode step.
 *
 * Above the client-side HTTP deadline (150 s) so the client gives up first and the
 * step reports *why*. A step killed by the platform's own limit reports a timeout
 * with no indication that the processor had already been asked to stop.
 */
export const ENCODE_STEP_TIMEOUT_MS = 165_000;

/** What the claim step decided. Small on purpose: steps return metadata, not rows. */
interface AdmitResult {
  outcome: 'claimed' | 'already_terminal' | 'lease_held' | 'not_found' | 'unclaimable';
  status: JobStatus;
}

interface EncodeResult {
  key: string;
  bytes: number;
  sha256: string;
  videoCodec: string;
  width: number;
  height: number;
  durationMs: number;
}

type CommitResult = 'committed' | 'fenced' | 'missing_output' | 'size_mismatch';

/**
 * What one execution of the encode step produced.
 *
 * A union rather than an exception, and the reason is specific: a Workflow step's
 * error crosses a serialization boundary on its way out, so `instanceof` against the
 * error class that was thrown is **false** in the code that catches it. A terminal
 * refusal therefore cannot be recognised by its type after the fact — so it is not
 * signalled by a type. It is *returned*.
 *
 * The distinction this preserves is the whole retry policy: `terminal` means the
 * bytes cannot encode and no further attempt should be spent, and a thrown error
 * means a transient failure the step's own retries should absorb.
 */
type EncodeAttempt =
  | { ok: true; artifact: EncodeResult }
  | { ok: false; terminal: true; reason: string };

/** The outcome of one attempt's container call. */
type ContainerOutcome =
  | { ok: true; artifact: EncodeResult }
  | { ok: false; retryable: boolean; message: string };

export class EncodeWorkflow extends WorkflowEntrypoint<JobsEnv, EncodeWorkflowParams> {
  /**
   * The Durable Object for one job.
   *
   * `idFromName(jobId)`: every attempt of one job addresses the same object, so
   * `max_instances: 2` bounds *jobs* in flight and a job's own attempts share one
   * container instead of starting one each.
   */
  private containerStub(jobId: string): DurableObjectStub {
    return this.env.CONTAINER?.get(this.env.CONTAINER?.idFromName(jobId));
  }

  override async run(event: WorkflowEvent<EncodeWorkflowParams>, step: WorkflowStep) {
    requireJobsBindings(this.env);
    requireJobsDeploymentEnvironment(this.env);
    const profile = resolveJobsProfile(this.env);
    if (!profile.ok) {
      throw new Error(`${profile.problem} ${profile.remedy}`);
    }
    if (profile.profile !== 'encode') {
      return { jobId: event.payload.jobId, outcome: 'compute_profile_disabled' };
    }
    if ((this.env.STARTER_BACKEND_PROFILE ?? 'legacy') === 'supabase') {
      for (let number = 0; number < MAX_JOB_ATTEMPTS; number += 1) {
        const result = await step.do(
          `supabase-cloud-run-${number + 1}`,
          {
            retries: { limit: 0, delay: 1000, backoff: 'constant' },
            timeout: 20 * 60 * 1000,
          },
          async () => {
            const attemptId = number === 0 ? event.payload.attemptId : createId('attempt');
            const outcome = await runCloudRunAttempt(this.env, {
              jobId: event.payload.jobId,
              attemptId,
            });
            return { attemptId, outcome: outcome.outcome };
          },
        );
        if (
          result.outcome === 'committed' ||
          result.outcome === 'fenced' ||
          result.outcome === 'terminal_failure'
        ) {
          return result;
        }
      }
      return { jobId: event.payload.jobId, outcome: 'attempts_exhausted' as const };
    }
    const params = event.payload;
    const repository = createJobRepository(this.env.DB as unknown as JobsDatabase, systemClock);
    const store = createMediaStore(this.env.MEDIA);

    const admitted = await step.do<AdmitResult>('admit', async () => {
      const claimed = await repository.claimAttempt(
        params.jobId,
        params.attemptId,
        systemClock.now() + JOB_ATTEMPT_LEASE_MS,
      );
      if (claimed.ok) {
        return { outcome: 'claimed', status: claimed.job.status };
      }
      // The refusal is a decision the single claiming statement already made; this
      // names it. A job another attempt owns is not this instance's work, and a
      // finished job is not either — which is what makes re-dispatching a completed
      // job a no-op instead of a second encode.
      let outcome: AdmitResult['outcome'] = 'already_terminal';
      if (claimed.reason === 'not_found') {
        outcome = 'not_found';
      } else if (claimed.reason === 'lease_held') {
        outcome = 'lease_held';
      } else if (claimed.reason === 'attempts_exhausted') {
        outcome = 'unclaimable';
      }
      const current = await this.readJobStatus(params.jobId);
      return { outcome, status: current };
    });

    if (admitted.outcome !== 'claimed') {
      return { jobId: params.jobId, outcome: admitted.outcome, status: admitted.status };
    }

    let attempt: EncodeAttempt;
    try {
      attempt = await step.do<EncodeAttempt>(
        'encode',
        {
          retries: {
            limit: ENCODE_STEP_RETRIES,
            delay: ENCODE_STEP_RETRY_DELAY_MS,
            backoff: 'constant',
          },
          timeout: ENCODE_STEP_TIMEOUT_MS,
        },
        async (): Promise<EncodeAttempt> => {
          const fixture = await store.readFixture(params.fixture, MAX_INPUT_BYTES);
          if (fixture === null) {
            // Terminal and immediate: the bytes this job was admitted to encode are
            // not in the store, and no retry will put them there.
            return {
              ok: false,
              terminal: true,
              reason: `The named fixture ${params.fixture} is not in the private store.`,
            };
          }
          const outcome = await this.encodeInto(store, params, fixture);
          if (!outcome.ok) {
            // Terminal refusals are returned so the platform stops; transient ones are
            // thrown so the step's own retry budget absorbs them.
            if (!outcome.retryable) {
              return { ok: false, terminal: true, reason: outcome.message };
            }
            throw new Error(outcome.message);
          }
          return { ok: true, artifact: outcome.artifact };
        },
      );
    } catch {
      // Only a transient failure reaches here: a terminal refusal is *returned* from
      // the step, so what arrives is a step whose retry budget is spent. The job must
      // end in a truthful state rather than stay `running` until maintenance notices —
      // a caller watching a job that says `running` for an hour is watching a lie.
      await step.do('fail', async () => {
        await repository.failAttempt(params.jobId, params.attemptId, 'attempts_exhausted');
        await this.releaseContainer(params.jobId);
        return true;
      });
      return {
        jobId: params.jobId,
        outcome: 'attempts_exhausted',
        status: 'failed' as const,
      };
    }

    if (!attempt.ok) {
      // Terminal refusal: one encode was attempted and the processor said the bytes
      // cannot become an artifact. The job ends `failed` with `encode_failed`, and
      // no second container start is spent on it.
      await step.do('fail', async () => {
        await repository.failAttempt(params.jobId, params.attemptId, 'encode_failed');
        await this.releaseContainer(params.jobId);
        return true;
      });
      return { jobId: params.jobId, outcome: 'failed', status: 'failed' as const };
    }

    const encoded = attempt.artifact;

    const committed = await step.do<CommitResult>('commit', async () => {
      // Re-read from the bucket rather than trusting what the stream believed it
      // wrote. The object *is* the artifact; the response is a claim about it.
      const head = await store.head(encoded.key);
      if (head === null) {
        await store.delete(encoded.key);
        return 'missing_output';
      }
      if (head.bytes !== encoded.bytes) {
        await store.delete(encoded.key);
        return 'size_mismatch';
      }
      const written = await repository.completeAttempt(params.jobId, params.attemptId, {
        key: encoded.key,
        bytes: encoded.bytes,
        sha256: encoded.sha256,
        containerFormat: 'mp4',
        videoCodec: encoded.videoCodec,
        width: encoded.width,
        height: encoded.height,
        durationMs: encoded.durationMs,
        expiresAt: systemClock.now() + JOB_OUTPUT_RETENTION_MS,
      });
      // `fenced` is not a failure: this attempt lost its lease, so the winner's
      // committed result stands and this one must not overwrite it.
      if (!written.ok) {
        await store.delete(encoded.key);
      }
      return written.ok ? 'committed' : 'fenced';
    });

    await step.do('cleanup', async () => {
      // Stop-after-work. The instance is told the job is over so the provider can
      // reclaim it, instead of waiting out the idle timeout.
      await this.releaseContainer(params.jobId);
      return true;
    });

    if (committed === 'committed' || committed === 'fenced') {
      return { jobId: params.jobId, outcome: committed, status: 'running' as const };
    }

    // The object is missing, or the wrong size, after the write reported success.
    // That is not a success with a broken download; it is a failure, and it is
    // recorded as one rather than committed.
    await step.do('fail-unverified-output', async () => {
      await repository.failAttempt(params.jobId, params.attemptId, 'encode_failed');
      return true;
    });
    return { jobId: params.jobId, outcome: committed, status: 'failed' as const };
  }

  /**
   * One attempt: read, send, store, verify.
   *
   * The integrity check is the load-bearing part. The processor reports a hash of
   * what it produced; the bytes that actually reach the bucket are hashed on their
   * way past, and a mismatch means the object stored under this attempt's key is not
   * the object the processor described. Committing that would publish a downloadable
   * artifact whose contents nothing has verified.
   */
  private async encodeInto(
    store: ReturnType<typeof createMediaStore>,
    params: EncodeWorkflowParams,
    fixture: { bytes: number; stream: ReadableStream<Uint8Array> },
  ): Promise<ContainerOutcome> {
    const processor = createProcessorClient({
      // The broker is addressed as a stub, not as a URL: this is an internal port
      // with no route, and there is nothing to resolve.
      fetcher: this.containerStub(params.jobId),
      origin: 'http://container',
      maxInputBytes: MAX_INPUT_BYTES,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });

    const outcome = await processor.encode(fixture.stream, {
      preset: params.preset,
      attemptId: params.attemptId,
      contentLength: fixture.bytes,
    });

    if (!outcome.ok) {
      return { ok: false, retryable: outcome.retryable, message: outcome.message };
    }

    const write = await store.putArtifact(
      params.jobId,
      params.attemptId,
      outcome.body,
      outcome.artifact.bytes,
    );

    // Terminal when the stored bytes are not the bytes the processor described:
    // re-sending the same input cannot change the processor's output, so this is
    // not a retry.
    if (write.bytes !== outcome.artifact.bytes || write.sha256 !== outcome.artifact.sha256) {
      await store.delete(write.key);
      return {
        ok: false,
        retryable: false,
        message:
          'The stored bytes do not match what the processor reported, so nothing is committed.',
      };
    }

    return {
      ok: true,
      artifact: {
        key: write.key,
        bytes: write.bytes,
        sha256: write.sha256,
        videoCodec: outcome.artifact.videoCodec,
        width: outcome.artifact.width,
        height: outcome.artifact.height,
        durationMs: outcome.artifact.durationMs,
      },
    };
  }

  /**
   * Tell the broker the job's work is over.
   *
   * Failure to reach the broker must not fail the job. The bytes are already
   * stored and the terminal write is already made; refusing to record a success
   * because a container could not be told to stop would trade a cosmetic
   * inefficiency for a false negative.
   */
  private async releaseContainer(jobId: string): Promise<void> {
    try {
      await this.containerStub(jobId).fetch('http://container/release', { method: 'POST' });
    } catch {
      // Reported by the provider's own container lifecycle; see the README.
    }
  }

  /**
   * The job's current status, for the refusal path.
   *
   * Read here rather than through `getJobForOwner` because that method — correctly —
   * requires an owner id, and this Workflow has none: it was started for a job id and
   * nothing else. Widening the repository with an owner-less reader would add an
   * authorization-shaped hole to a package whose design is owner-scoped reads, so the
   * one column is read here, from the same binding, on a path where the job has
   * already been shown not to be claimable by this attempt.
   */
  private async readJobStatus(jobId: string): Promise<JobStatus> {
    const row = await this.env.DB.prepare('SELECT status FROM jobs WHERE id = ?')
      .bind(jobId)
      .first<{ status: JobStatus }>();
    return row?.status ?? 'failed';
  }
}

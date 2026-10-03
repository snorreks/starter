// apps/backend/jobs/src/encode_container.ts
//
// The container Durable Object: the one component in this Worker that may reach the
// FFmpeg container, and the component that carries its bytes.
//
// What it is for
// --------------
// A Cloudflare Container is controlled from a Durable Object, so *something* has to
// hold the handle. Putting that something here is what makes the access boundary
// checkable rather than aspirational:
//
//   * `EncodeContainerEnv` declares one binding — `PROCESSOR_ORIGIN`, and only as
//     an alternative to the container it owns. There is no `DB` and no `MEDIA` in
//     its type, so it cannot read a job row or an artifact even by accident.
//   * A container started by this object has no account credentials, no R2 key and
//     no D1 binding. Bytes go in on the request and come back on the response.
//   * There is no public route to it. It is addressed by a stub, from the Workflow,
//     for one job.
//
// The three operations are the smallest set that works:
//
//   POST /encode   forward a bounded body to the processor and stream the answer
//   POST /release  this job is over; stop the instance (stop-after-work)
//   GET  /health   the processor's own `/health`, for a start-up probe
//
// Retry-safety
// ------------
// Nothing here is idempotent in the "safe to repeat" sense, and nothing pretends
// to be. The processor refuses concurrent encodes with `429 busy`, so a repeated
// request either finds the slot free (and encodes again, which is what a retry
// means) or is refused. What this object *does* guarantee is that a repeated
// request cannot produce two artifacts for one attempt: the bytes only ever leave
// this Worker through the response, and the caller stores them under an
// attempt-scoped key.

import { DurableObject } from 'cloudflare:workers';
import { MEDIA_CONTAINER_PORT, resolveProcessorOrigin } from './env.ts';
import { MAX_INPUT_BYTES, MAX_OUTPUT_BYTES } from './media_store.ts';
import {
  createProcessorClient,
  type EncodeProcessor,
  HEALTH_DEADLINE_MS,
  PROCESSOR_ENCODE_PATH,
  PROCESSOR_PRESET_ID,
  PROCESSOR_PROTOCOL_ID,
} from './processor_client.ts';

/**
 * The bindings this object may see.
 *
 * Deliberately not `JobsEnv`. A Durable Object's `env` is the Worker's binding set
 * narrowed by what the class is written against, and the point of this interface
 * is that it is *narrower*: no `DB`, no `MEDIA`, no workflow bindings. The
 * container's whole security argument is that it holds no credential, and a type
 * that included one would make that argument a comment.
 */
export interface EncodeContainerEnv {
  /** Optional processor this object does not run itself. See `../env.ts`. */
  readonly PROCESSOR_ORIGIN?: string;
}

/**
 * How long the instance may sit idle after an encode before the provider stops it.
 *
 * The stop-after-work fallback. There is no `stop_after_work` key in the pinned
 * Wrangler schema (4.142.0), so "stop when the work is done" is expressed as an
 * inactivity timeout the object arms itself: long enough that a second attempt of
 * the same job reuses a warm instance, short enough that an abandoned job does not
 * keep a container billed.
 */
export const CONTAINER_IDLE_TIMEOUT_MS = 120_000;

/**
 * How long the instance is kept after the job's work is finished.
 *
 * Short on purpose. `release` means "this job is over", and the only work that can
 * still arrive is another recovery pass for the same job; a few seconds covers that
 * and no more.
 */
export const CONTAINER_RELEASE_TIMEOUT_MS = 5_000;

export class EncodeContainer extends DurableObject<EncodeContainerEnv> {
  /**
   * Reach the processor.
   *
   * Two paths, one client. `ctx.container.getTcpPort(...)` is the platform path
   * and it is preferred whenever the object has a container; `PROCESSOR_ORIGIN` is
   * the escape hatch for a processor this Worker does not run.
   *
   * A configured `PROCESSOR_ORIGIN` *wins* over the container when both exist. That
   * is the local compute lane's configuration, where the container runtime does not
   * exist but a real FFmpeg container is running on a port — and it is stated
   * rather than left implicit, because "which processor answered" is exactly the
   * question an operator needs answered by reading the configuration.
   */
  private processor(): EncodeProcessor {
    const configured = resolveProcessorOrigin(this.env.PROCESSOR_ORIGIN);
    if (!configured.ok) {
      throw new Error(configured.problem);
    }
    if (configured.origin.length > 0) {
      return createProcessorClient({
        fetcher: fetch,
        origin: configured.origin,
        maxInputBytes: MAX_INPUT_BYTES,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
    }
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error(
        'This jobs Worker has neither a container nor PROCESSOR_ORIGIN, so there is no ' +
          'processor to reach. Bind the container in apps/backend/jobs/wrangler.jsonc, or ' +
          'set PROCESSOR_ORIGIN to a processor this Worker does not run.',
      );
    }
    return createProcessorClient({
      fetcher: container.getTcpPort(MEDIA_CONTAINER_PORT),
      origin: `http://127.0.0.1:${MEDIA_CONTAINER_PORT}`,
      maxInputBytes: MAX_INPUT_BYTES,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
  }

  /** Arm the idle fallback after every unit of work. */
  private async armIdleTimeout(ms: number): Promise<void> {
    try {
      await this.ctx.container?.setInactivityTimeout(ms);
    } catch {
      // A container that cannot accept a timeout change is not a reason to fail the
      // encode: the request already has its answer, and the provider stops an
      // instance with no work either way. Failing here would turn a delivered
      // artifact into a failed attempt.
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === PROCESSOR_ENCODE_PATH) {
      return this.encode(request);
    }
    if (request.method === 'POST' && url.pathname === '/release') {
      await this.armIdleTimeout(CONTAINER_RELEASE_TIMEOUT_MS);
      return Response.json({ released: true });
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      const health = await this.processor().health(HEALTH_DEADLINE_MS);
      return health === null
        ? Response.json({ reachable: false }, { status: 503 })
        : Response.json({ reachable: true, protocol: health.protocol, release: health.release });
    }
    return new Response('Not found', { status: 404 });
  }

  /**
   * Forward one encode.
   *
   * The body is forwarded as a stream and the answer is returned as a stream, so
   * the bytes are never held here. The status and the processor's own response
   * headers are passed through unchanged — this object is a transport, and any
   * decision it made about the answer would be a second place where the retry
   * policy lives.
   */
  private async encode(request: Request): Promise<Response> {
    const length = request.headers.get('content-length');
    if (length === null) {
      // The processor refuses chunked framing, so a request without a length is
      // refused here with the same code it would get there — reported as a
      // terminal framing error rather than as a container start that fails.
      return Response.json(
        {
          error: {
            code: 'unsupported_transfer_encoding',
            message: 'A length is required.',
            retryable: false,
          },
        },
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    }

    const processor = this.processor();
    const outcome = await processor.encode(request.body as ReadableStream<Uint8Array>, {
      // The preset is not read from the request: it is the one the protocol has. A
      // caller cannot name another, because there is no other.
      preset: PROCESSOR_PRESET_ID,
      attemptId: request.headers.get('x-attempt-id') ?? 'unknown',
      contentLength: Number(length),
    });

    if (!outcome.ok) {
      // The refusal is re-issued in the processor's own document shape, and the
      // *caller* is the component that decides what a code means — reproducing a
      // status from the code here would be a second place that has to know the
      // classification.
      //
      // Two statuses are worth preserving because the caller's transport distinguishes
      // them: `busy` is 429 (try again later) and `internal_error` is 500 (this side
      // is broken). Everything else is a 400 — the request itself was refused — and
      // the retry decision still comes from the `retryable` field, not from the
      // status.
      let status = 400;
      if (outcome.code === 'busy') {
        status = 429;
      } else if (outcome.code === 'internal_error') {
        status = 500;
      }
      return Response.json(
        { error: { code: outcome.code, message: outcome.message, retryable: outcome.retryable } },
        { status, headers: { 'content-type': 'application/json' } },
      );
    }

    await this.armIdleTimeout(CONTAINER_IDLE_TIMEOUT_MS);

    return new Response(outcome.body, {
      status: 200,
      headers: {
        'content-type': 'video/mp4',
        'x-protocol': PROCESSOR_PROTOCOL_ID,
        'x-preset': PROCESSOR_PRESET_ID,
        'x-attempt-id': request.headers.get('x-attempt-id') ?? 'unknown',
        'x-output-bytes': String(outcome.artifact.bytes),
        'x-output-sha256': outcome.artifact.sha256,
        'x-output-codec': outcome.artifact.videoCodec,
        'x-output-dimensions': `${outcome.artifact.width}x${outcome.artifact.height}`,
        'x-output-duration-ms': String(outcome.artifact.durationMs),
      },
    });
  }
}

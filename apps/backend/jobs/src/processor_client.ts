// apps/backend/jobs/src/processor_client.ts
//
// The narrow service port in front of the FFmpeg processor.
//
// What this port is
// -----------------
// One operation — "turn these bounded bytes into those bounded bytes under this
// frozen preset" — and a refusal that says whether the same bytes are worth
// sending again. Nothing else about the processor leaks through it: no FFmpeg
// argument, no stderr, no filesystem path, no way to name an output format.
//
// It is a port rather than a direct `fetch` because the *same* code has to reach
// two different things:
//
//   * the Durable Object's container port (`ctx.container.getTcpPort(8080)`), in a
//     deployment, and
//   * a processor this Worker does not run itself — a self-hosted host, or the
//     local compute lane's Docker container — through `PROCESSOR_ORIGIN`.
//
// Both are a `Fetcher`-shaped object with a `fetch` method, so one client serves
// both and the unit lane can drive it against a real local server that speaks the
// real protocol. What the client adds on top is the part that must not be left to
// the transport: bounded input, an explicit deadline, a validated response, and the
// retryability decision.
//
// The retry decision
// ------------------
// Terminal versus retryable is taken from the processor's own frozen code
// (`RETRYABLE_PROCESSOR_ERROR_CODES` in `@starter/schemas/jobs`), not from an HTTP
// status. `invalid_media` is a 400 and terminal; `busy` is a 429 and retryable; a
// 503 with `deadline_exceeded` is retryable and the same 503 with `cancelled`
// usually is not worth repeating. A status-code table would get every one of those
// wrong in at least one direction, and "wrong" here means either a wasted attempt
// or a job that never finishes.
//
// Content-Length is declared, not left to the transport
// -----------------------------------------------------
// The processor refuses `Transfer-Encoding: chunked` and requires a
// `Content-Length`, because honouring chunked would mean trusting a length the
// client may lie about. So the caller must know the input size before the request
// starts — which is why `contentLength` is a required field and why the workflow
// reads the fixture's size from the bucket before streaming it.

export {
  PROCESSOR_PRESET_ID,
  PROCESSOR_PROTOCOL_ID,
} from '@starter/schemas/jobs';

import type { JobPreset } from '@starter/schemas/jobs';
import {
  isRetryableProcessorError,
  PROCESSOR_HEADER_ATTEMPT,
  PROCESSOR_HEADER_PRESET,
  PROCESSOR_HEADER_PROTOCOL,
  PROCESSOR_PRESET_ID,
  PROCESSOR_PROTOCOL_ID,
  type ProcessorErrorCode,
  type ProcessorHealth,
} from '@starter/schemas/jobs';
import { withKnownLength } from './stream.ts';

/** The media path the processor serves. */
export const PROCESSOR_ENCODE_PATH = '/encode';

/** The processor's liveness path. Never encodes; used by a start-up probe. */
export const PROCESSOR_HEALTH_PATH = '/health';

/**
 * Wall-clock ceiling on one encode request, in milliseconds.
 *
 * Above the processor's own 120 s FFmpeg deadline on purpose. The process deadline
 * is the processor's contract with itself; this is *this* Worker's contract with
 * the network — a socket that never answers must not hold a Workflow step for the
 * platform's own (much longer) step timeout, because "slow" and "never" have to be
 * the same event or an attempt can hang for as long as the platform allows.
 */
export const ENCODE_HTTP_DEADLINE_MS = 150_000;

/** Ceiling on a health probe, which must never become a load generator. */
export const HEALTH_DEADLINE_MS = 10_000;

/**
 * Anything that can perform a request.
 *
 * Two shapes, because the platform has two: a container port
 * (`ctx.container.getTcpPort(8080)`) is a `Fetcher` object with a `fetch` method,
 * and `PROCESSOR_ORIGIN` is reached with the global `fetch` function. Accepting
 * both means one client, one set of validations, and no caller-specific branch.
 */
export type ProcessorFetcher =
  | ((input: string, init?: RequestInit) => Promise<Response>)
  | { fetch(input: string, init?: RequestInit): Promise<Response> };

const asFetchFunction = (
  candidate: ProcessorFetcher,
): ((input: string, init?: RequestInit) => Promise<Response>) =>
  typeof candidate === 'function' ? candidate : candidate.fetch.bind(candidate);

/** What the processor reported about the bytes it produced. */
export interface ProcessorArtifact {
  bytes: number;
  /** Lowercase hex, as the processor reported it. Compared against what we stored. */
  sha256: string;
  containerFormat: string;
  videoCodec: string;
  width: number;
  height: number;
  durationMs: number;
}

export type ProcessorOutcome =
  | {
      ok: true;
      artifact: ProcessorArtifact;
      /** The real bytes. Streamed into storage, never into a step result. */
      body: ReadableStream<Uint8Array>;
    }
  | {
      ok: false;
      code: ProcessorErrorCode;
      retryable: boolean;
      /** A fixed sentence. Never provider text, never stderr. */
      message: string;
    };

export interface EncodeRequest {
  /** Frozen preset name. The only one this protocol has. */
  preset: JobPreset;
  /** Echoed by the processor; an echo mismatch is treated as a protocol failure. */
  attemptId: string;
  /** Declared length. The processor refuses a request that has none. */
  contentLength: number;
}

export interface EncodeProcessor {
  /** Liveness and identity: the release, the protocol, the limits. */
  health(deadlineMs?: number): Promise<ProcessorHealth | null>;
  encode(
    input: ReadableStream<Uint8Array>,
    request: EncodeRequest,
    deadlineMs?: number,
  ): Promise<ProcessorOutcome>;
}

/**
 * Parse a non-2xx processor response into a refusal.
 *
 * A body that is not the frozen error document is reported as `internal_error`
 * rather than as whatever text arrived: this code ends up deciding whether an
 * attempt is retried, and an unparseable answer is a transport problem, not a
 * claim about the media.
 */
const readRefusal = async (response: Response): Promise<ProcessorOutcome> => {
  let code: ProcessorErrorCode = 'internal_error';
  let message = 'The processor refused the request.';
  try {
    const document: unknown = await response.json();
    const error = (document as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    if (typeof error?.code === 'string' && typeof error.message === 'string') {
      if (isKnownCode(error.code)) {
        code = error.code;
        message = error.message;
      }
    }
  } catch {
    // Left at the default: a body this code cannot read is a transport problem.
  }
  return { ok: false, code, retryable: isRetryableProcessorError(code), message };
};

const CODES = new Set<string>([
  'input_empty',
  'payload_too_large',
  'unsupported_transfer_encoding',
  'protocol_mismatch',
  'unsupported_preset',
  'invalid_attempt_id',
  'busy',
  'invalid_media',
  'output_too_large',
  'invalid_output',
  'deadline_exceeded',
  'cancelled',
  'not_found',
  'internal_error',
]);

const isKnownCode = (value: string): value is ProcessorErrorCode => CODES.has(value);

const parseDimensions = (value: string | null): { width: number; height: number } | null => {
  if (value === null) {
    return null;
  }
  const match = /^(\d{1,5})x(\d{1,5})$/.exec(value.trim());
  if (match === null) {
    return null;
  }
  return { width: Number(match[1]), height: Number(match[2]) };
};

const readPositiveInt = (value: string | null): number | null => {
  if (value === null || !/^\d{1,12}$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Build the client.
 *
 * `origin` is the processor's base URL. It is a parameter rather than read from an
 * environment variable inside this module, because the same client is used from the
 * Worker (where it is `http://127.0.0.1:<port>` on a container port) and from a
 * Durable Object (where it is `PROCESSOR_ORIGIN`), and a module-scope environment
 * read would make those two the same value.
 */
export const createProcessorClient = (options: {
  fetcher: ProcessorFetcher;
  origin: string;
  maxInputBytes: number;
  maxOutputBytes: number;
}): EncodeProcessor => {
  const { origin } = options;
  const doFetch = asFetchFunction(options.fetcher);

  const deadline = async <T>(work: (signal: AbortSignal) => Promise<T>, ms: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await work(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };

  const url = (path: string): string => `${origin}${path}`;

  return {
    async health(healthDeadlineMs = HEALTH_DEADLINE_MS): Promise<ProcessorHealth | null> {
      try {
        const response = await deadline(
          (signal) => doFetch(url(PROCESSOR_HEALTH_PATH), { method: 'GET', signal }),
          healthDeadlineMs,
        );
        if (!response.ok) {
          return null;
        }
        const document: unknown = await response.json();
        const health = document as ProcessorHealth;
        // Only the two fields this Worker actually acts on are checked. The
        // processor's `/health` is the authority on its own identity, and a
        // mismatch here means the wrong processor answered — which is a refusal,
        // not something to encode through.
        if (health.protocol !== PROCESSOR_PROTOCOL_ID) {
          return null;
        }
        return health;
      } catch {
        return null;
      }
    },

    async encode(input, request, encodeDeadlineMs = ENCODE_HTTP_DEADLINE_MS) {
      // Refused here rather than sent and refused: the processor would answer
      // `payload_too_large`, but this is a client-side bound and saying so costs
      // one comparison instead of a round trip with 5 MiB already on the wire.
      if (request.contentLength > options.maxInputBytes) {
        return {
          ok: false,
          code: 'payload_too_large',
          retryable: false,
          message: `The input is ${request.contentLength} bytes, over this deployment's ceiling.`,
        };
      }
      if (request.contentLength <= 0) {
        return {
          ok: false,
          code: 'input_empty',
          retryable: false,
          message: 'The input stream is empty.',
        };
      }

      let response: Response;
      try {
        response = await deadline(
          (signal) =>
            doFetch(url(PROCESSOR_ENCODE_PATH), {
              method: 'POST',
              headers: {
                'content-type': 'application/octet-stream',
                // Declared, never chunked: the processor refuses chunked framing
                // because honouring it means trusting an unbounded length.
                'content-length': String(request.contentLength),
                [PROCESSOR_HEADER_PROTOCOL]: PROCESSOR_PROTOCOL_ID,
                [PROCESSOR_HEADER_PRESET]: request.preset,
                [PROCESSOR_HEADER_ATTEMPT]: request.attemptId,
              },
              body: withKnownLength(input, request.contentLength),
              // `duplex` is required by the fetch spec whenever a stream is the
              // body, and workerd enforces it. Without it the request fails at
              // the transport with an error that says nothing about the media.
              duplex: 'half',
              signal,
            } as RequestInit),
          encodeDeadlineMs,
        );
      } catch {
        // A transport failure is retryable by definition: the bytes never reached
        // a decision, and re-sending identical bytes to a restarted container is
        // exactly what a retry is for.
        return {
          ok: false,
          code: 'internal_error',
          retryable: true,
          message: 'The processor could not be reached.',
        };
      }

      if (!response.ok) {
        return readRefusal(response);
      }

      // The echo is checked before the body is trusted. A processor that answered
      // a different attempt, preset or protocol than the one requested did not do
      // this job, and streaming its bytes into storage under this attempt's key
      // would make one attempt's success another's artifact.
      if (
        response.headers.get(PROCESSOR_HEADER_PROTOCOL) !== PROCESSOR_PROTOCOL_ID ||
        response.headers.get(PROCESSOR_HEADER_PRESET) !== PROCESSOR_PRESET_ID ||
        response.headers.get(PROCESSOR_HEADER_ATTEMPT) !== request.attemptId
      ) {
        return {
          ok: false,
          code: 'invalid_output',
          retryable: false,
          message: 'The processor answered for a different attempt, preset or protocol.',
        };
      }

      const bytes = readPositiveInt(response.headers.get('x-output-bytes'));
      const sha256 = response.headers.get('x-output-sha256');
      const codec = response.headers.get('x-output-codec');
      const dimensions = parseDimensions(response.headers.get('x-output-dimensions'));
      const durationMs = readPositiveInt(response.headers.get('x-output-duration-ms'));

      if (
        bytes === null ||
        sha256 === null ||
        !/^[0-9a-f]{64}$/.test(sha256) ||
        codec === null ||
        codec.length === 0 ||
        dimensions === null ||
        durationMs === null
      ) {
        return {
          ok: false,
          code: 'invalid_output',
          retryable: false,
          message: 'The processor reported output this build cannot read.',
        };
      }
      if (bytes > options.maxOutputBytes) {
        return {
          ok: false,
          code: 'output_too_large',
          retryable: false,
          message: `The processor reported ${bytes} bytes, over this deployment's ceiling.`,
        };
      }

      return {
        ok: true,
        artifact: {
          bytes,
          sha256,
          containerFormat: 'mp4',
          videoCodec: codec,
          width: dimensions.width,
          height: dimensions.height,
          durationMs,
        },
        body: response.body as ReadableStream<Uint8Array>,
      };
    },
  };
};

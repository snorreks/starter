// packages/frontend/features/src/jobs/jobs_output.ts
//
// Turning an authenticated byte response into something a media element can play.
//
// The problem this exists to solve
// --------------------------------
// A `<video src="/api/jobs/job_1/output">` works in a browser and cannot work in a
// native shell. Media elements issue their own request with no header, and a
// native shell's credential is a bearer token — so the request goes out anonymous
// and answers 401. The usual workarounds are the two this repository refuses:
//
//   * a long-lived token in the query string, which ends up in a history entry, a
//     `Referer`, a proxy log and a crash report;
//   * a short-lived capability URL, which is a second authorization surface with
//     its own storage, its own expiry and nobody to revoke it.
//
// So the bytes are fetched *through the transport*, which is the only place a
// credential is ever attached, and the answer becomes a Blob the caller owns. No
// credential is ever in a URL, and revoking the session revokes the media the
// moment the next fetch happens.
//
// Two obligations come with holding a Blob
// ----------------------------------------
// An object URL pins its Blob in memory for the life of the document: a Blob never
// freed is a video the user encoded, held forever, on every visit. `revoke()` is
// therefore part of this module's contract rather than a line the view remembers,
// and the ViewModel calls it on replacement *and* on disposal.
//
// The ceiling is here, not in the view. The server already bounds the artifact at
// the processor's own 10 MiB, and this refuses anything larger rather than handing
// a media element a buffer it will try to decode.

/**
 * Largest artifact this screen will play.
 *
 * The same number as `JobOutputSchema.bytes.maximum`, which is the processor's
 * `max_output_bytes`. Stated here because a client that trusts its own ceiling is
 * what makes the server's ceiling meaningful; a deployment serving a larger file
 * gets a refusal it can act on rather than a stalled player.
 */
export const MAX_JOB_OUTPUT_BYTES = 10 * 1024 * 1024;

/** The media type the job contract produces. */
export const JOB_OUTPUT_MEDIA_TYPE = 'video/mp4';

/** The two platform calls, behind an interface so a test can count them. */
export interface ObjectUrlFactory {
  create(blob: Blob): string;
  revoke(url: string): void;
}

/** The browser's implementation. Absent outside a DOM, which a test must say. */
export const browserObjectUrls = (): ObjectUrlFactory => ({
  create: (blob) => URL.createObjectURL(blob),
  revoke: (url) => {
    URL.revokeObjectURL(url);
  },
});

export interface JobOutputHandle {
  readonly jobId: string;
  /** An object URL. Never a credential, never a request path. */
  readonly url: string;
  readonly bytes: number;
  readonly filename: string;
  /** Idempotent. Releasing twice is a no-op, not an error. */
  revoke(): void;
}

/**
 * A file name derived from the job id.
 *
 * The id is server-generated (`job_…`) and is the only untrusted input here,
 * because a download's `download` attribute is written straight into a file name.
 * Anything outside `[A-Za-z0-9_-]` is dropped, which leaves a name that is
 * either the id or empty — and an empty name falls back to a fixed one rather than
 * producing `.mp4`.
 */
export const outputFilename = (jobId: string): string => {
  const safe = jobId.replace(/[^A-Za-z0-9_-]/g, '');
  return `${safe.length === 0 ? 'starter-sample' : `starter-sample-${safe}`}.mp4`;
};

export type JobOutputRejection = 'empty' | 'too_large';

/**
 * The bytes cannot be played, and the reason is one a user can be told.
 *
 * Thrown rather than returned as null so a screen has to decide what to render:
 * "this result cannot be played here" is a different statement from "nothing has
 * been loaded yet", and a `null` that both mean would make the second hide the
 * first.
 */
export class JobOutputRejectedError extends Error {
  readonly reason: JobOutputRejection;
  readonly bytes: number;
  readonly ceiling: number;

  constructor(reason: JobOutputRejection, bytes: number, ceiling: number) {
    super(
      reason === 'empty'
        ? 'That result came back with no bytes.'
        : `That result is ${bytes} bytes, above the ${ceiling}-byte ceiling this screen plays.`,
    );
    this.name = 'JobOutputRejectedError';
    this.reason = reason;
    this.bytes = bytes;
    this.ceiling = ceiling;
  }
}

/**
 * Take ownership of `bytes` as playable, revocable media.
 *
 * Throws `JobOutputRejectedError` for an empty or oversized answer, rather than
 * handing back a Blob cut to the ceiling: a truncated Blob is a file that plays
 * to the wrong moment and reports success.
 */
export const takeOutputHandle = (
  jobId: string,
  bytes: Uint8Array,
  urls: ObjectUrlFactory = browserObjectUrls(),
): JobOutputHandle => {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_JOB_OUTPUT_BYTES) {
    throw new JobOutputRejectedError(
      bytes.byteLength === 0 ? 'empty' : 'too_large',
      bytes.byteLength,
      MAX_JOB_OUTPUT_BYTES,
    );
  }

  /**
   * Copy into a plain `ArrayBuffer` rather than handing the view to the `Blob`.
   *
   * The view may be a slice of a larger buffer with a wider backing store, and a
   * `Blob` built from the view's `buffer` would carry the whole thing. The copy
   * is bounded by the ceiling checked above, so it costs at most 10 MiB once.
   */
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: JOB_OUTPUT_MEDIA_TYPE });
  const url = urls.create(blob);
  let released = false;

  return {
    jobId,
    url,
    bytes: bytes.byteLength,
    filename: outputFilename(jobId),
    revoke() {
      // Guarded rather than left to the caller: a revoke is reachable from a
      // disposal, from a replacement and from a second disposal, and an
      // un-guarded double revoke is how a screen ends up freeing a URL a newer
      // handle is using.
      if (released) {
        return;
      }
      released = true;
      urls.revoke(url);
    },
  };
};

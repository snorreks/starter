// apps/backend/jobs/src/stream.ts
//
// One helper for the runtime requirement that a streamed request or upload body
// have a length the runtime can check.
//
// workerd answers `TypeError: Provided readable stream must have a known length` for
// a `ReadableStream` body whose length it cannot determine — which is every stream,
// when the surrounding call also declares `Content-Length`. The compute lane is what
// found it: the same request succeeds through `fetch` and fails through a Durable
// Object stub, and an R2 upload of a plain stream fails for the same reason.
//
// `FixedLengthStream` is the platform's way to declare "this stream is exactly N
// bytes", and it is also a *check*: a stream that ends early or runs long is an error
// rather than a truncated upload. That is the property worth having here, because the
// number comes from the processor's own report and the mismatch is exactly what the
// integrity check must catch.
//
// The capability check is deliberate. Bun — where the unit lane runs — does not
// implement `FixedLengthStream` and does not require it, so the stream is wrapped
// where the class exists and passed through where it does not. Both paths send the
// same bytes with the same declared length; only the transport's strictness differs,
// and the lane that runs in workerd is the one that exercises the strict path.

/** Whether this runtime can declare a stream's length. */
export const canDeclareStreamLength = (): boolean => typeof FixedLengthStream === 'function';

/**
 * The stream, with its length declared where the runtime supports declaring one.
 *
 * `length` must be the byte count the caller *expects*. A stream that disagrees is an
 * error in a runtime that can check, and an unchecked upload in one that cannot —
 * which is why every caller here has a number it independently believes.
 */
export const withKnownLength = (
  stream: ReadableStream<Uint8Array>,
  length: number,
): ReadableStream<Uint8Array> =>
  canDeclareStreamLength() ? stream.pipeThrough(new FixedLengthStream(length)) : stream;

import { AppError } from '@starter/utils';

/**
 * Read one stream into frames, incrementally.
 *
 * A hand-written reader rather than the decoder in `@starter/schemas/chat`, and
 * that split is deliberate: the shared decoder takes a whole body and exists so the
 * encoder and decoder can be proved to agree in a unit test with no streams
 * involved. This one has to work across arbitrary chunk boundaries, which is a
 * different problem — a frame can be split mid-JSON by the network, and a reader
 * that assumed otherwise would drop or corrupt it.
 *
 * The buffer holds decoded *text*, not bytes, and a partial UTF-8 sequence at a
 * chunk boundary would be a real hazard if it did — so `TextDecoder` is used with
 * `stream: true`, which carries an incomplete sequence over to the next chunk.
 */
export async function* readChatFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const frameDelimiter = /\r?\n\r?\n/g;
  let scanOffset = 0;
  let ended = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        ended = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      // Dispatch every *complete* frame: one that ends in the blank line that
      // terminates it. A trailing partial frame stays in the buffer for the next
      // chunk, which is what makes a frame split across two reads still parse.
      for (;;) {
        frameDelimiter.lastIndex = scanOffset;
        const delimiter = frameDelimiter.exec(buffer);
        const boundary = delimiter?.index ?? -1;
        if ((boundary === -1 ? buffer.length : boundary) > 1_048_576) {
          throw new AppError('server', 'The stream frame is too large.');
        }
        if (boundary === -1) {
          // A CRLF delimiter can begin in the last three characters of this chunk.
          scanOffset = Math.max(0, buffer.length - 3);
          break;
        }
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (delimiter?.[0].length ?? 2));
        scanOffset = 0;
        const parsed = parseOneFrame(raw);
        if (parsed !== undefined) {
          yield parsed;
        }
      }
    }

    // Whatever is left after the final read. A stream that ended mid-frame is
    // malformed, and `parseOneFrame` refuses it rather than yielding a partial one.
    const tail = parseOneFrame(buffer);
    if (tail !== undefined) {
      yield tail;
    }
  } finally {
    try {
      if (!ended) {
        await reader.cancel();
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * Parse one frame's raw text, or `undefined` for a frame that carries no data.
 *
 * Comment-only frames — which is how the done sentinel travels — yield nothing.
 * That is the point of the sentinel: it marks the end of the stream without adding
 * a frame type the protocol would then have to declare.
 */
const parseOneFrame = (raw: string): unknown => {
  const dataLines: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(':')) {
      continue;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) {
      value = value.slice(1);
    }
    if (field === 'data') {
      dataLines.push(value);
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }

  const joined = dataLines.join('\n');
  try {
    return JSON.parse(joined) as unknown;
  } catch {
    // Returned as a non-frame marker so the caller's `isChatStreamEvent` check is
    // what refuses it — one place decides what a valid frame is, not two.
    return { __unparseable: joined.slice(0, 200) };
  }
};

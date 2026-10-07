// apps/frontend/client/src/lib/server/http.ts
//
// The small set of things every API route adapter needs, in one place.
//
// A JSON error shape, a body size limit and schema-driven request validation
// are explicit here. SvelteKit's `+server.ts` is a plain `Request`/`Response`
// pair, so they cannot be declarative route options. Explicit is also what
// lets the *response* side stay honest: a route that forgets `readJsonBody`
// is visible in review, whereas a route that forgets a validation option was
// invisible.
//
// Valibot implements Standard Schema, so request validation consumes the shared
// contracts without a validator-specific adapter.

import type { StandardSchemaV1 } from '@standard-schema/spec';

/** The one error shape every API route returns. */
export interface ApiErrorBody {
  error: string;
  message: string;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

export const jsonError = (status: number, error: string, message: string): Response =>
  Response.json({ error, message } satisfies ApiErrorBody, { status, headers: JSON_HEADERS });

export const json = (status: number, body: unknown): Response =>
  Response.json(body, { status, headers: JSON_HEADERS });

/**
 * 401 for an anonymous request. One place, so the shape cannot drift.
 */
export const unauthorized = (): Response => jsonError(401, 'unauthorized', 'Sign in to continue.');

/**
 * 404 rather than 403 for a note the caller does not own.
 *
 * The update and delete filters both include `owner_id`, so a note owned by
 * someone else is indistinguishable from one that does not exist. Deliberate: a
 * 403 would confirm the note exists, turning the endpoint into an existence
 * oracle for other users' data.
 */
export const noteNotFound = (): Response =>
  jsonError(404, 'not_found', 'That note does not exist.');

/**
 * The answer to a request that arrived before the app was configured.
 *
 * Two shapes on purpose. An API caller gets the same `{ error, message }` JSON as
 * every other API response, so a client parsing errors does not have to special-case
 * this one. A browser gets plain text, because the reader is a person looking at a
 * 503 and the message names the missing binding — that text is the entire reason
 * this response exists instead of a generic 500.
 *
 * The message contains a binding name and a file path, never a value.
 */
export const notConfigured = (message: string, isApi: boolean): Response =>
  isApi
    ? jsonError(503, 'not_configured', message)
    : new Response(`${message}\n`, {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });

export type ReadBodyResult<T> = { ok: true; value: T } | { ok: false; response: Response };

/**
 * Read a JSON body, bounded in bytes, and validate it against `schema`.
 *
 * The byte ceiling is enforced while reading rather than from `content-length`
 * alone. A declared length is the sender's claim, and trusting it is how a
 * "limit" gets bypassed with one header. The stream is read chunk by chunk and
 * abandoned the moment it passes the limit, so an oversized body is never held in
 * memory in full.
 *
 * Validation uses the caller's Standard Schema, which means an
 * unknown field is a refusal rather than a silently dropped value — every schema
 * in `@starter/schemas` sets `additionalProperties: false` for exactly that.
 */
export const readJsonBody = async <S extends StandardSchemaV1>(
  request: Request,
  schema: S,
  options: { maxBytes: number; invalidStatus?: number },
): Promise<ReadBodyResult<StandardSchemaV1.InferOutput<S>>> => {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > options.maxBytes) {
    return {
      ok: false,
      response: jsonError(413, 'payload_too_large', 'The request body is too large.'),
    };
  }

  const text = await readBoundedText(request, options.maxBytes);
  if (text === null) {
    return {
      ok: false,
      response: jsonError(413, 'payload_too_large', 'The request body is too large.'),
    };
  }

  if (text.trim().length === 0) {
    return { ok: false, response: invalidBody('A JSON body is required.', options) };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, response: invalidBody('The request body is not valid JSON.', options) };
  }

  const validated = schema['~standard'].validate(parsed);
  if (validated instanceof Promise || validated.issues) {
    return { ok: false, response: invalidBody('The request body is not valid.', options) };
  }

  return { ok: true, value: validated.value };
};

/**
 * The answer to a body this endpoint's schema refuses.
 *
 * `status` exists because the jobs contract freezes 400 for an invalid create
 * body while the rest of this API answers 422. Both are correct; what would not be
 * is a second body reader written for the one endpoint that disagrees, because the
 * byte ceiling and the closed-schema refusal are the two things most worth having
 * exactly one implementation of.
 */
const invalidBody = (message: string, options: { invalidStatus?: number }): Response =>
  jsonError(options.invalidStatus ?? 422, 'validation', message);

/**
 * Read a request body as text, or `null` once it exceeds `maxBytes`.
 *
 * A `null` return means "too large", not "empty". An absent body is an empty
 * string, and the two produce different answers to the caller.
 */
export const readBoundedText = async (
  request: Request,
  maxBytes: number,
): Promise<string | null> => {
  const body = request.body;
  if (body === null) {
    return '';
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        // Cancelled rather than drained: the point of the limit is to stop
        // reading, not to finish reading and then throw the bytes away.
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(concat(chunks, total));
};

const concat = (chunks: readonly Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

// apps/frontend/client/src/routes/api/notes/+server.ts
//
// `/api/notes` — the collection. A thin adapter over the notes server service.
//
// Thin is a specific claim, not a compliment: this file resolves who the caller
// is, validates the request body against the shared TypeBox schema, and maps a
// service result to a status code. It contains no SQL, no ownership rule and no
// domain logic, because those live in `#lib/server/notes_service.ts` where they
// can be reached from the SSR load as well as from here.
//
// The same service backs `src/routes/notes/+page.server.ts`. There is no second
// authorization check and no second mutation path: the browser's mutations go
// through these endpoints, and a server load never fetches its own origin.

import { NoteCreateSchema, type NoteList } from '@starter/schemas/notes';
import { json, jsonError, readJsonBody, unauthorized } from '#lib/server/http.ts';
import { createNotesService } from '#lib/server/notes_service.ts';
import { buildRequestContext } from '#lib/server/request_context.ts';
import type { RequestHandler } from './$types';

/**
 * No `content-length` cap for note bodies beyond this.
 *
 * A note is capped at 4000 characters by `NoteCreateSchema`, so 64 KiB is
 * generous for a JSON envelope around it and small enough that a hostile client
 * cannot make the Worker hold an arbitrary body.
 */
const MAX_BODY_BYTES = 64 * 1024;

export const GET: RequestHandler = async ({ locals }) => {
  const user = locals.user;
  if (user === null) {
    return unauthorized();
  }

  // No `buildRequestContext` call here, and that asymmetry is the point. `locals.user`
  // was already resolved from this request by the composition root, so building a
  // second context would resolve the same session twice. The read path does not log
  // per request — the write paths below do, because a write is the event worth
  // correlating.
  const notes = await createNotesService(locals.container.db).list(user.id);
  const body: NoteList = { notes, serverTime: Date.now() };
  return json(200, body);
};

export const POST: RequestHandler = async ({ locals, request }) => {
  const context = await buildRequestContext(request, locals.container);
  const user = locals.user;
  if (user === null) {
    return unauthorized();
  }

  const parsed = await readJsonBody(request, NoteCreateSchema, { maxBytes: MAX_BODY_BYTES });
  if (!parsed.ok) {
    return parsed.response;
  }

  const service = createNotesService(locals.container.db);
  const note = await service.create(user.id, parsed.value as { title: string; body: string });

  context.logger.info('notes.create', { noteId: note.id, traceId: context.traceId });
  return json(200, note);
};

/** The collection has no other verbs, and saying so beats a framework 405 page. */
export const PUT = (): Response => jsonError(405, 'method_not_allowed', 'Use GET or POST here.');
export const DELETE = (): Response => jsonError(405, 'method_not_allowed', 'Use GET or POST here.');

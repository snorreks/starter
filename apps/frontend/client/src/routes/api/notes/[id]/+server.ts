// apps/frontend/client/src/routes/api/notes/[id]/+server.ts
//
// `/api/notes/:id` — a single note. Updates and deletes only; there is no
// `GET` by id, because the list endpoint already returns whole notes and a
// per-note read would be a second way to reach the same rows.
//
// A note the caller does not own answers 404, not 403. The service filters on
// `owner_id` in the same statement as the id, so "not yours" and "not there" are
// the same result; answering 403 would turn this into an existence oracle for
// other users' data.

import { NoteUpdateSchema } from '@starter/schemas/notes';
import { json, jsonError, noteNotFound, readJsonBody, unauthorized } from '#lib/server/http.ts';
import { createNotesService } from '#lib/server/notes_service.ts';
import { buildRequestContext } from '#lib/server/request_context.ts';
import type { RequestHandler } from './$types';

const MAX_BODY_BYTES = 64 * 1024;

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  const user = locals.user;
  if (user === null) {
    return unauthorized();
  }

  const parsed = await readJsonBody(request, NoteUpdateSchema, { maxBytes: MAX_BODY_BYTES });
  if (!parsed.ok) {
    return parsed.response;
  }

  const context = await buildRequestContext(request, locals.container);
  const note = await createNotesService(locals.container.db).update(
    user.id,
    params.id,
    parsed.value as { title?: string; body?: string },
  );

  if (note === null) {
    return noteNotFound();
  }

  context.logger.info('notes.update', { noteId: note.id, traceId: context.traceId });
  return json(200, note);
};

export const DELETE: RequestHandler = async ({ locals, params, request }) => {
  const user = locals.user;
  if (user === null) {
    return unauthorized();
  }

  const context = await buildRequestContext(request, locals.container);
  const removed = await createNotesService(locals.container.db).remove(user.id, params.id);
  if (!removed) {
    return noteNotFound();
  }

  context.logger.info('notes.delete', { noteId: params.id, traceId: context.traceId });
  // 204 with no body, which is what the previous API returned and what
  // `NotesService.remove` already treats as success.
  return new Response(null, { status: 204 });
};

export const GET = (): Response =>
  jsonError(405, 'method_not_allowed', 'Use PATCH or DELETE here. List at /api/notes.');
export const POST = (): Response =>
  jsonError(405, 'method_not_allowed', 'Use PATCH or DELETE here.');

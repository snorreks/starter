import { NoteIdSchema } from '@starter/schemas/common';
import {
  NoteCreateSchema,
  NotePageSchema,
  NoteSchema,
  NoteUpdateSchema,
} from '@starter/schemas/notes';
import { error } from '@sveltejs/kit';
import * as v from 'valibot';
import { createNotesRemoteService, NoteNotFoundError } from '#lib/server/notes_remote_service.ts';
import { command, form, getRequestEvent, query } from '$app/server';

const CursorInput = v.strictObject({
  cursor: v.union([v.pipe(v.string(), v.maxLength(1024)), v.null()]),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50))),
});
const IdInput = v.strictObject({ id: NoteIdSchema });
const UpdateInput = v.strictObject({ id: NoteIdSchema, input: NoteUpdateSchema });
const DeleteResultSchema = v.strictObject({ deleted: v.boolean() });

const adapter = () => {
  const event = getRequestEvent();
  if (event.locals.user === null) {
    error(401, 'Authentication required.');
  }
  if (
    event.locals.context.backendProfile !== 'supabase' ||
    event.locals.context.services === null
  ) {
    error(503, 'Notes remote functions require the Supabase application services.');
  }
  return createNotesRemoteService(event.locals.context.services.notes, event.locals.user.id);
};

export const listNotes = query(CursorInput, async ({ cursor, limit = 30 }) => {
  try {
    return v.parse(NotePageSchema, await adapter().list(cursor, limit));
  } catch (cause) {
    if (cause instanceof TypeError) {
      error(400, 'The notes cursor is malformed or belongs to another account.');
    }
    throw cause;
  }
});

export const createNote = form(NoteCreateSchema, async (input) => {
  return v.parse(NoteSchema, await adapter().create(input));
});
export const createNoteCommand = command(NoteCreateSchema, async (input) =>
  v.parse(NoteSchema, await adapter().create(input)),
);

export const updateNote = command(UpdateInput, async ({ id, input }) => {
  try {
    return v.parse(NoteSchema, await adapter().update(id, input));
  } catch (cause) {
    if (cause instanceof NoteNotFoundError) {
      error(404, cause.message);
    }
    throw cause;
  }
});

export const deleteNote = command(IdInput, async ({ id }) =>
  v.parse(DeleteResultSchema, { deleted: await adapter().remove(id) }),
);

import * as v from 'valibot';
import { NoteIdSchema, UserIdSchema } from '../common/ids.ts';

export const NOTE_TITLE_MAX_LENGTH = 120;
export const NOTE_BODY_MAX_LENGTH = 4000;
export const NoteSchema = v.strictObject({
  id: NoteIdSchema,
  ownerId: UserIdSchema,
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(NOTE_TITLE_MAX_LENGTH)),
  body: v.pipe(v.string(), v.maxLength(NOTE_BODY_MAX_LENGTH)),
  createdAt: v.number(),
  updatedAt: v.number(),
});
export type Note = v.InferOutput<typeof NoteSchema>;
export const NoteCreateSchema = v.strictObject({
  title: v.pipe(v.string(), v.minLength(1), v.maxLength(NOTE_TITLE_MAX_LENGTH)),
  body: v.pipe(v.string(), v.maxLength(NOTE_BODY_MAX_LENGTH)),
});
export type NoteCreate = v.InferOutput<typeof NoteCreateSchema>;
export const NoteUpdateSchema = v.pipe(
  v.strictObject({
    title: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(NOTE_TITLE_MAX_LENGTH))),
    body: v.optional(v.pipe(v.string(), v.maxLength(NOTE_BODY_MAX_LENGTH))),
  }),
  v.check((value) => Object.keys(value).length > 0, 'At least one note field must be provided.'),
);
export type NoteUpdate = v.InferOutput<typeof NoteUpdateSchema>;
export const NoteListSchema = v.strictObject({
  notes: v.array(NoteSchema),
  serverTime: v.number(),
});
export type NoteList = v.InferOutput<typeof NoteListSchema>;
export const validateNoteInput = (input: {
  title: string;
  body: string;
}): Record<string, string> => {
  const errors: Record<string, string> = {};
  if (input.title.trim().length === 0) {
    errors.title = 'A title is required.';
  } else if (input.title.length > NOTE_TITLE_MAX_LENGTH) {
    errors.title = `A title must be ${NOTE_TITLE_MAX_LENGTH} characters or fewer.`;
  }
  if (input.body.length > NOTE_BODY_MAX_LENGTH) {
    errors.body = `A note must be ${NOTE_BODY_MAX_LENGTH} characters or fewer.`;
  }
  return errors;
};

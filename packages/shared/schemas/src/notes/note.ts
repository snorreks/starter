// packages/shared/schemas/src/notes/note.ts
//
// The demo domain. Small on purpose: one owned entity with a full
// create/read/update/delete path so that the ViewModel/service/backend
// conventions are exercised end to end without game-specific complexity.
//
// `additionalProperties: false` everywhere means `Value.Check` is a refusal
// mechanism, not a coercion mechanism: an unknown field is an error, never a
// silently dropped value.

import { type Static, Type } from 'typebox';
import { NoteIdSchema, UserIdSchema } from '../common/ids.ts';

export const NOTE_TITLE_MAX_LENGTH = 120;
export const NOTE_BODY_MAX_LENGTH = 4000;

/** A note exactly as the API returns it. */
export const NoteSchema = Type.Object(
  {
    id: NoteIdSchema,
    ownerId: UserIdSchema,
    title: Type.String({ minLength: 1, maxLength: NOTE_TITLE_MAX_LENGTH }),
    body: Type.String({ maxLength: NOTE_BODY_MAX_LENGTH }),
    /** Epoch milliseconds. */
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
  },
  { additionalProperties: false },
);

export type Note = Static<typeof NoteSchema>;

/** Create payload. The server derives `ownerId` from the session, never the body. */
export const NoteCreateSchema = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: NOTE_TITLE_MAX_LENGTH }),
    body: Type.String({ maxLength: NOTE_BODY_MAX_LENGTH }),
  },
  { additionalProperties: false },
);

export type NoteCreate = Static<typeof NoteCreateSchema>;

/** Update payload. Omitted fields are left unchanged. */
export const NoteUpdateSchema = Type.Object(
  {
    title: Type.Optional(Type.String({ minLength: 1, maxLength: NOTE_TITLE_MAX_LENGTH })),
    body: Type.Optional(Type.String({ maxLength: NOTE_BODY_MAX_LENGTH })),
  },
  { additionalProperties: false, minProperties: 1 },
);

export type NoteUpdate = Static<typeof NoteUpdateSchema>;

export const NoteListSchema = Type.Object(
  {
    notes: Type.Array(NoteSchema),
    /** Echoed so a client can detect that its list is from a newer server. */
    serverTime: Type.Number(),
  },
  { additionalProperties: false },
);

export type NoteList = Static<typeof NoteListSchema>;

/**
 * Domain rule kept next to the schema so the client can show the same message
 * the server would, without a round trip.
 */
export const validateNoteInput = (input: {
  title: string;
  body: string;
}): Record<string, string> => {
  const errors: Record<string, string> = {};
  const title = input.title.trim();

  if (title.length === 0) {
    errors.title = 'A title is required.';
  } else if (title.length > NOTE_TITLE_MAX_LENGTH) {
    errors.title = `A title must be ${NOTE_TITLE_MAX_LENGTH} characters or fewer.`;
  }

  if (input.body.length > NOTE_BODY_MAX_LENGTH) {
    errors.body = `A note must be ${NOTE_BODY_MAX_LENGTH} characters or fewer.`;
  }

  return errors;
};

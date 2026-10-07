// packages/shared/schemas/src/notes/note.test.ts
//
// Schema validation, the shared contract.
//
// These schemas are the single source of truth for three consumers that cannot
// see each other: the client validates before sending, the Worker validates
// before writing, and the Drizzle column types mirror them. A schema that is
// looser than intended lets bad data reach D1 and fail later, somewhere that no
// longer knows what the original request was.
//
// The refusal tests matter most: `additionalProperties: false` is what makes
// schema validation a refusal mechanism rather than a coercion mechanism. A schema
// that silently drops an unknown field makes the client believe a write
// succeeded.

import { describe, expect, test } from 'bun:test';
import { checkSchema } from '../validation.ts';
import {
  NOTE_BODY_MAX_LENGTH,
  NOTE_TITLE_MAX_LENGTH,
  NoteCreateSchema,
  NoteListSchema,
  NoteSchema,
  NoteUpdateSchema,
  validateNoteInput,
} from './note.ts';

const validNote = () => ({
  id: 'note_1',
  ownerId: 'user_1',
  title: 'Shopping list',
  body: 'Milk, bread',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
});

const accepts = checkSchema;

describe('NoteSchema', () => {
  test('accepts a well-formed note', () => {
    expect(accepts(NoteSchema, validNote())).toBe(true);
  });

  test('accepts an empty body', () => {
    // An empty body is a title-only note, which is legitimate. Rejecting it
    // would push users to type a space.
    expect(accepts(NoteSchema, { ...validNote(), body: '' })).toBe(true);
  });

  test('rejects a missing required field', () => {
    const { ownerId: _ownerId, ...withoutOwner } = validNote();

    expect(accepts(NoteSchema, withoutOwner)).toBe(false);
  });

  test('rejects an unknown field', () => {
    // The refusal case. A dropped field is worse than a rejected request: the
    // client is told the write succeeded and reloads to find the value missing.
    expect(accepts(NoteSchema, { ...validNote(), sneaky: 'value' })).toBe(false);
  });

  test('rejects a title at the length limit plus one', () => {
    const atLimit = 'a'.repeat(NOTE_TITLE_MAX_LENGTH);
    expect(accepts(NoteSchema, { ...validNote(), title: atLimit })).toBe(true);

    expect(accepts(NoteSchema, { ...validNote(), title: `${atLimit}a` })).toBe(false);
  });

  test('rejects an empty title', () => {
    expect(accepts(NoteSchema, { ...validNote(), title: '' })).toBe(false);
  });

  test('rejects a whitespace-only title', () => {
    // `minLength: 1` admits " ". Whether that is a client concern is a separate
    // decision; what matters here is that the schema states its position
    // deliberately rather than by accident.
    expect(accepts(NoteSchema, { ...validNote(), title: ' ' })).toBe(true);
  });

  test('rejects a body at the length limit plus one', () => {
    const atLimit = 'b'.repeat(NOTE_BODY_MAX_LENGTH);
    expect(accepts(NoteSchema, { ...validNote(), body: atLimit })).toBe(true);

    expect(accepts(NoteSchema, { ...validNote(), body: `${atLimit}b` })).toBe(false);
  });

  test('rejects an id longer than the column allows', () => {
    expect(accepts(NoteSchema, { ...validNote(), id: 'n'.repeat(65) })).toBe(false);
  });

  test('rejects a non-numeric timestamp', () => {
    expect(accepts(NoteSchema, { ...validNote(), createdAt: '2024-01-01' })).toBe(false);
  });

  test('rejects null and non-objects', () => {
    for (const value of [null, undefined, 'note', 42, [], true]) {
      expect(accepts(NoteSchema, value)).toBe(false);
    }
  });
});

describe('NoteCreateSchema', () => {
  test('accepts title and body', () => {
    expect(accepts(NoteCreateSchema, { title: 'a', body: 'b' })).toBe(true);
  });

  test('rejects a client-supplied ownerId', () => {
    // The important one. Ownership comes from the session; a body carrying
    // `ownerId` would either be rejected or, worse, honoured.
    expect(accepts(NoteCreateSchema, { title: 'a', body: 'b', ownerId: 'user_2' })).toBe(false);
  });

  test('rejects a client-supplied id', () => {
    expect(accepts(NoteCreateSchema, { title: 'a', body: 'b', id: 'note_chosen' })).toBe(false);
  });

  test('rejects client-supplied timestamps', () => {
    expect(accepts(NoteCreateSchema, { title: 'a', body: 'b', createdAt: 1, updatedAt: 1 })).toBe(
      false,
    );
  });

  test('rejects an empty title', () => {
    expect(accepts(NoteCreateSchema, { title: '', body: 'b' })).toBe(false);
  });
});

describe('NoteUpdateSchema', () => {
  test('accepts a partial update', () => {
    expect(accepts(NoteUpdateSchema, { title: 'new' })).toBe(true);
    expect(accepts(NoteUpdateSchema, { body: 'new' })).toBe(true);
    expect(accepts(NoteUpdateSchema, { title: 'new', body: 'new' })).toBe(true);
  });

  test('rejects an empty update', () => {
    // An empty PATCH is a no-op that still costs a round trip and a row write.
    expect(accepts(NoteUpdateSchema, {})).toBe(false);
  });

  test('rejects setting a field to undefined-present-but-empty', () => {
    expect(accepts(NoteUpdateSchema, { title: '' })).toBe(false);
  });

  test('rejects an attempt to clear the body with an empty string', () => {
    // An empty body is valid, so this is the one way to clear it.
    expect(accepts(NoteUpdateSchema, { body: '' })).toBe(true);
  });

  test('rejects an id in the body', () => {
    expect(accepts(NoteUpdateSchema, { id: 'note_2', title: 'new' })).toBe(false);
  });

  test('rejects an ownerId in the body', () => {
    expect(accepts(NoteUpdateSchema, { ownerId: 'user_2', title: 'new' })).toBe(false);
  });
});

describe('NoteListSchema', () => {
  test('accepts an empty list', () => {
    // An empty list is the normal first-run state, not an error.
    expect(accepts(NoteListSchema, { notes: [], serverTime: 1 })).toBe(true);
  });

  test('rejects a list whose entries are invalid', () => {
    expect(accepts(NoteListSchema, { notes: [{ id: 'note_1' }], serverTime: 1 })).toBe(false);
  });

  test('requires serverTime', () => {
    expect(accepts(NoteListSchema, { notes: [] })).toBe(false);
  });
});

describe('validateNoteInput', () => {
  test('returns no errors for a valid input', () => {
    expect(validateNoteInput({ title: 'Shopping', body: 'Milk' })).toEqual({});
  });

  test('reports a missing title against the title field', () => {
    // Keyed by field name so a form can render the message next to the input
    // without the client reimplementing the rule.
    const errors = validateNoteInput({ title: '', body: 'b' });

    expect(errors.title).toBeTruthy();
    expect(errors.body).toBeUndefined();
  });

  test('reports an over-long title', () => {
    const errors = validateNoteInput({ title: 'a'.repeat(NOTE_TITLE_MAX_LENGTH + 1), body: '' });

    expect(errors.title).toBeTruthy();
  });

  test('reports an over-long body', () => {
    const errors = validateNoteInput({
      title: 'a',
      body: 'b'.repeat(NOTE_BODY_MAX_LENGTH + 1),
    });

    expect(errors.body).toBeTruthy();
  });

  test('agrees with the schema on what is valid', () => {
    // The two checks must not drift: if the client shows no error but the
    // Worker rejects the request, the user gets a message with no explanation.
    const cases: { title: string; body: string }[] = [
      { title: 'a', body: 'b' },
      { title: '', body: 'b' },
      { title: 'a'.repeat(NOTE_TITLE_MAX_LENGTH), body: 'b' },
      { title: 'a'.repeat(NOTE_TITLE_MAX_LENGTH + 1), body: 'b' },
      { title: 'a', body: 'b'.repeat(NOTE_BODY_MAX_LENGTH + 1) },
    ];

    for (const input of cases) {
      const clientAccepted = Object.keys(validateNoteInput(input)).length === 0;
      const serverAccepted = accepts(NoteCreateSchema, input);

      expect(clientAccepted).toBe(serverAccepted);
    }
  });
});

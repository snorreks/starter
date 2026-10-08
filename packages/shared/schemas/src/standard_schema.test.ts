import { describe, expect, test } from 'bun:test';
import { UserIdSchema } from './common/ids.ts';
import {
  NOTE_TITLE_MAX_LENGTH,
  NoteCreateSchema,
  NoteSchema,
  NoteUpdateSchema,
} from './notes/note.ts';
import { checkSchema, parseSchema } from './validation.ts';

describe('shared Standard Schema validation', () => {
  test('rejects fields the wire contract does not own', () => {
    expect(checkSchema(NoteCreateSchema, { title: 'valid', body: '', ownerId: 'other' })).toBe(
      false,
    );
  });

  test('parses without changing the submitted wire object', () => {
    const input = { title: 'valid', body: '' };
    expect(parseSchema(NoteCreateSchema, input)).toEqual(input);
  });

  test('preserves JavaScript UTF-16 length limits for emoji', () => {
    const title = `😀${'a'.repeat(NOTE_TITLE_MAX_LENGTH - 2)}`;
    const note = {
      id: 'n1',
      ownerId: 'f45b2c4a-7919-4f55-ae89-e73f6753e322',
      title,
      body: '',
      createdAt: 1,
      updatedAt: 1,
    };
    expect(checkSchema(NoteSchema, note)).toBe(true);
    expect(checkSchema(NoteSchema, { ...note, title: `${title}a` })).toBe(false);
  });

  test('accepts UUID identities and rejects legacy user tokens', () => {
    expect(checkSchema(UserIdSchema, 'f45b2c4a-7919-4f55-ae89-e73f6753e322')).toBe(true);
    expect(checkSchema(UserIdSchema, 'usr_legacy')).toBe(false);
  });

  test('rejects empty updates and preserves valid updates', () => {
    expect(checkSchema(NoteUpdateSchema, {})).toBe(false);
    expect(checkSchema(NoteUpdateSchema, { body: '' })).toBe(true);
  });
});

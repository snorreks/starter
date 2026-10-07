import { describe, expect, test } from 'bun:test';
import { NoteCreateSchema } from '@starter/schemas';
import { AppError } from '@starter/utils';
import { parseDto } from './dto.ts';

describe('parseDto', () => {
  test('returns the Standard Schema output for a valid response', () => {
    const response = { title: 'hello', body: '' };
    expect(parseDto(NoteCreateSchema, response, 'a note')).toEqual(response);
  });

  test('classifies unrecognized responses as server errors', () => {
    try {
      parseDto(NoteCreateSchema, { title: 'hello', body: '', ownerId: 'other' }, 'a note');
      throw new Error('expected parseDto to reject unknown response fields');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      if (!(error instanceof AppError)) {
        throw error;
      }
      expect(error.errorType).toBe('server');
      expect(error.status).toBe(200);
      expect(error.message).toContain('a note');
    }
  });
});

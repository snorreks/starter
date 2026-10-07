import type { NotesRepository } from '@starter/database/supabase';
import type { NoteCreate, NotePage, NoteUpdate } from '@starter/schemas/notes';
import { NotePageSchema, NoteSchema } from '@starter/schemas/notes';
import * as v from 'valibot';

export const createNotesRemoteService = (repository: NotesRepository, ownerId: string) => ({
  async list(cursor: string | null, limit: number): Promise<NotePage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new RangeError('Notes page limit must be between 1 and 50.');
    }
    const page = await repository.list(ownerId, cursor, limit);
    return v.parse(NotePageSchema, {
      items: page.notes,
      nextCursor: page.nextCursor,
      hasMore: page.hasMore,
      serverTime: page.serverTime,
    });
  },
  async create(input: NoteCreate) {
    return v.parse(NoteSchema, await repository.create(ownerId, input));
  },
  async update(id: string, input: NoteUpdate) {
    const note = await repository.update(ownerId, id, input);
    if (note === null) {
      throw new NoteNotFoundError();
    }
    return v.parse(NoteSchema, note);
  },
  remove: (id: string) => repository.remove(ownerId, id),
});

export class NoteNotFoundError extends Error {
  constructor() {
    super('That note does not exist.');
    this.name = 'NoteNotFoundError';
  }
}

import type { NotesRepository } from '@starter/database/supabase';
import type { Note, NoteCreate, NoteUpdate } from '@starter/schemas/notes';

const MAX_LISTED_NOTES = 200;

export interface NotesService {
  list(ownerId: string): Promise<Note[]>;
  create(ownerId: string, input: NoteCreate): Promise<Note>;
  update(ownerId: string, id: string, input: NoteUpdate): Promise<Note | null>;
  remove(ownerId: string, id: string): Promise<boolean>;
}

export const createRequestNotesService = (locals: {
  context: {
    user: { id: string } | null;
    services: { identity: { user: { id: string } }; notes: NotesRepository } | null;
  };
}): NotesService => {
  const services = locals.context.services;
  if (!services || !locals.context.user || services.identity.user.id !== locals.context.user.id) {
    throw new Error("Notes require this request's verified Supabase identity.");
  }
  const owner = (id: string) => {
    if (id !== services.identity.user.id) {
      throw new Error('Notes owner does not match the verified identity.');
    }
  };
  return {
    async list(ownerId) {
      owner(ownerId);
      const notes: Note[] = [];
      let cursor: string | null = null;
      while (notes.length < MAX_LISTED_NOTES) {
        const page = await services.notes.list(ownerId, cursor);
        notes.push(...page.notes.slice(0, MAX_LISTED_NOTES - notes.length));
        if (!page.hasMore || page.nextCursor === null) {
          break;
        }
        cursor = page.nextCursor;
      }
      return notes;
    },
    create(ownerId, input) {
      owner(ownerId);
      return services.notes.create(ownerId, input);
    },
    update(ownerId, id, input) {
      owner(ownerId);
      return services.notes.update(ownerId, id, input);
    },
    remove(ownerId, id) {
      owner(ownerId);
      return services.notes.remove(ownerId, id);
    },
  };
};

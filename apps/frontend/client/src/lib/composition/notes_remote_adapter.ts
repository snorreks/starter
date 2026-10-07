import type { NoteCreate, NoteUpdate } from '@starter/schemas/notes';
import { createNoteCommand, deleteNote, listNotes, updateNote } from '#lib/remote/notes.remote.ts';

/** Feature facade backed by generated wrappers; no remote query object enters the feature package. */
export const createRemoteNotesFeatureService = () => ({
  className: 'NotesRemoteService',
  async list(signal?: AbortSignal) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    const all = [];
    let cursor: string | null = null;
    do {
      if (signal?.aborted) {
        throw signal.reason;
      }
      const query = listNotes({ cursor, limit: 50 });
      await query.refresh();
      if (signal?.aborted) {
        throw signal.reason;
      }
      const page = await query;
      if (signal?.aborted) {
        throw signal.reason;
      }
      all.push(...page.items.slice(0, 200 - all.length));
      cursor = page.hasMore ? page.nextCursor : null;
    } while (cursor !== null && all.length < 200);
    return all;
  },
  create: (input: NoteCreate) => createNoteCommand(input),
  update: (id: string, input: NoteUpdate) => updateNote({ id, input }),
  async remove(id: string) {
    await deleteNote({ id });
  },
});

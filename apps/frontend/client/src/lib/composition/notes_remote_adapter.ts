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
      const query = listNotes({ cursor, limit: 50 });
      await query.refresh();
      const page = await query;
      all.push(...page.items);
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

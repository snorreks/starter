// apps/frontend/client/src/lib/services/notes_service.svelte.ts
//
// Transport + caching for notes. The *only* place that knows the notes HTTP
// shape.
//
// Why this is a service and not methods on the ViewModel:
//   - the note list is needed by more than one screen, and a second copy of a
//     fetch call is a second thing to keep correct
//   - it gives one place to log, to abort, and to invalidate
//
// What it deliberately does NOT do: hold the note list as duplicated mutable
// state. The list lives in the ViewModel that owns the screen. This service is
// stateless apart from its in-flight request bookkeeping, so the two can never
// disagree about what the user sees.

import { BaseClass } from '@starter/utils';
import type { Note, NoteCreate, NoteUpdate } from '@starter/schemas/notes';
import { apiClient, type ApiClient } from './api_client.ts';

export class NotesService extends BaseClass {
  readonly #api: ApiClient;

  constructor(options: { api?: ApiClient; className?: string } = {}) {
    super({ className: options.className ?? 'NotesService' });
    this.#api = options.api ?? apiClient;
  }

  list(signal?: AbortSignal): Promise<Note[]> {
    return this.#api
      .get<{ notes: Note[] }>('/api/notes', { signal })
      .then((response) => response.notes);
  }

  /**
   * Create a note.
   *
   * The server owns the id and both timestamps. The client does not mint an id
   * or send a timestamp: an optimistic row would have to be reconciled with the
   * server's, and the two would disagree the first time a clock is skewed. The
   * list updates from the response, which is the row that actually exists.
   */
  create(input: NoteCreate, signal?: AbortSignal): Promise<Note> {
    return this.#api.post<Note>('/api/notes', input, { signal });
  }

  update(id: string, input: NoteUpdate, signal?: AbortSignal): Promise<Note> {
    return this.#api.patch<Note>(`/api/notes/${encodeURIComponent(id)}`, input, { signal });
  }

  remove(id: string, signal?: AbortSignal): Promise<void> {
    return this.#api.delete<void>(`/api/notes/${encodeURIComponent(id)}`, { signal });
  }
}

export const notesService = NotesService.create({ className: 'NotesService' });

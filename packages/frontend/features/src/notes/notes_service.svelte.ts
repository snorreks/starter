// packages/frontend/features/src/notes/notes_service.svelte.ts
//
// Transport for notes. The *only* place that knows the notes HTTP shape.
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
//
// The transport is injected and never imported. `ApiTransport` is the whole
// reason this file can serve a web page and a native shell from one copy: the
// browser host resolves relative paths and carries the session cookie, a native
// host resolves an absolute origin and carries a bearer token, and neither fact
// reaches this file. What *is* common to both hosts is stated once here — the
// path, the method, the body, and the schema the answer must satisfy.

import { type ApiTransport, parseDto } from '@starter/platform';
import {
  type Note,
  type NoteCreate,
  NoteListSchema,
  NoteSchema,
  type NoteUpdate,
} from '@starter/schemas/notes';

export class NotesService {
  readonly className: string;
  readonly #transport: ApiTransport;

  constructor(options: { transport: ApiTransport; className?: string }) {
    this.className = options.className ?? 'NotesService';
    this.#transport = options.transport;
  }

  /**
   * One owner's notes, newest-first from the server.
   *
   * The response is checked against `NoteListSchema` before it is handed on.
   * `parseBody as Note[]` would compile just as well and would turn a proxy's
   * HTML error page, or a server from two deploys ago with a renamed field, into
   * a screen showing nothing at all — reported to the user as "you have no notes"
   * rather than as the version skew it is.
   */
  async list(signal?: AbortSignal): Promise<Note[]> {
    const body = await this.#transport.request<unknown>('/api/notes', {
      method: 'GET',
      ...(signal === undefined ? {} : { signal }),
    });
    return parseDto(NoteListSchema, body, 'a note list').notes;
  }

  /**
   * Create a note.
   *
   * The server owns the id and both timestamps. The client does not mint an id
   * or send a timestamp: an optimistic row would have to be reconciled with the
   * server's, and the two would disagree the first time a clock is skewed. The
   * list updates from the response, which is the row that actually exists.
   *
   * `ownerId` is not a parameter and not accepted in `input`. The create schema
   * sets `additionalProperties: false`, so a body carrying it is refused by the
   * server rather than accepted and ignored.
   */
  async create(input: NoteCreate, signal?: AbortSignal): Promise<Note> {
    const body = await this.#transport.request<unknown>('/api/notes', {
      method: 'POST',
      body: input,
      ...(signal === undefined ? {} : { signal }),
    });
    return parseDto(NoteSchema, body, 'a note');
  }

  async update(id: string, input: NoteUpdate, signal?: AbortSignal): Promise<Note> {
    const body = await this.#transport.request<unknown>(`/api/notes/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: input,
      ...(signal === undefined ? {} : { signal }),
    });
    return parseDto(NoteSchema, body, 'a note');
  }

  /**
   * Delete a note.
   *
   * The abort signal is forwarded but its firing is **not** proof the server did
   * not delete. A caller that wants certainty reloads; see `NotesViewModel`.
   *
   * A 204 is the success, so there is no body to validate. `undefined` is the
   * only correct answer here and asserting otherwise would fail on a correct
   * server.
   */
  async remove(id: string, signal?: AbortSignal): Promise<void> {
    await this.#transport.request<undefined>(`/api/notes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

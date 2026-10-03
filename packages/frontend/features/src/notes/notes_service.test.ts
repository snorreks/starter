// packages/frontend/features/src/notes/notes_service.test.ts
//
// The contract boundary: what the service does with an answer it did not ask for.
//
// The old client asked for `{ notes: Note[] }` and believed whatever came back.
// `parseBody as T` compiles identically whether the server sent notes, an error
// envelope from a different deploy, or an HTML page from an intermediary — so the
// failure arrived three layers away as a screen showing no notes, reported to the
// user as "you have no notes yet" rather than as the version skew it was.
//
// Every case here is a response the transport would happily hand over. What is
// refused is the *shape*, at the one place that knows the schema.
//
// No SvelteKit, no network, no app runtime: the transport is a fake object. That
// is the property the extraction is for, and this file is its proof — it runs in
// the shared package's own Bun lane, where nothing from `apps/` is resolvable.

import { describe, expect, test } from 'bun:test';
import type { ApiTransport, TransportRequestOptions } from '@starter/platform';
import type { Note } from '@starter/schemas/notes';
import { AppError } from '@starter/utils';
import { NotesService } from './notes_service.svelte.ts';

const note = (overrides: Partial<Note> = {}): Note => ({
  id: 'note_1',
  ownerId: 'user_1',
  title: 'first',
  body: 'body',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  ...overrides,
});

interface Recorded {
  readonly path: string;
  readonly options: TransportRequestOptions | undefined;
}

/** A transport that returns whatever it was told to and records the call. */
const transportReturning = (body: unknown, calls: Recorded[] = []): ApiTransport => ({
  async request<T>(path: string, options?: TransportRequestOptions): Promise<T> {
    calls.push({ path, options });
    return body as T;
  },
});

const service = (body: unknown, calls?: Recorded[]): NotesService =>
  new NotesService({ transport: transportReturning(body, calls) });

describe('a note list is validated rather than trusted', () => {
  test('a well-formed list is returned', async () => {
    const notes = await service({ notes: [note()], serverTime: 1 }).list();

    expect(notes).toHaveLength(1);
    expect(notes[0]?.title).toBe('first');
  });

  test('a list that is not an object at all is refused', async () => {
    // What an intermediary returns instead of the API. `as Note[]` would have
    // made this an empty screen rather than an error.
    const failure = (await service('<html>502</html>')
      .list()
      .catch((error: unknown) => error)) as AppError;

    expect(failure).toBeInstanceOf(AppError);
    expect(failure.errorType).toBe('server');
    expect(failure.message).toMatch(/note list/);
  });

  test('an unknown field on a note is refused, not ignored', async () => {
    // The schema is closed on purpose. A server that starts sending an extra
    // field is a deploy skew, and quietly dropping it hides the skew until a
    // user notices the field is missing.
    const failure = (await service({
      notes: [{ ...note(), ownerId: 'user_1', internalScore: 1 }],
      serverTime: 1,
    })
      .list()
      .catch((error: unknown) => error)) as AppError;

    expect(failure).toBeInstanceOf(AppError);
    expect(failure.errorType).toBe('server');
  });

  test('a missing field is refused rather than left undefined', async () => {
    const { title: _dropped, ...withoutTitle } = note();

    const failure = (await service({ notes: [withoutTitle], serverTime: 1 })
      .list()
      .catch((error: unknown) => error)) as AppError;

    expect(failure).toBeInstanceOf(AppError);
  });

  test('the error names the contract, so a reader three layers down knows what failed', async () => {
    const failure = (await service(null)
      .list()
      .catch((error: unknown) => error)) as AppError;

    expect(failure.message).toMatch(/does not understand/);
  });
});

describe('a single note is validated on write as well as read', () => {
  test('create returns the server row, not the payload that was sent', async () => {
    // The client does not mint an id. So the row that comes back is the only
    // one that exists, and a caller that used its own optimistic id would
    // reconcile against a key the server never issued.
    const created = await service(note({ id: 'note_server', title: 'from the server' })).create({
      title: 'from the client',
      body: '',
    });

    expect(created.id).toBe('note_server');
    expect(created.title).toBe('from the server');
  });

  test('a create answered with something else is refused', async () => {
    const failure = (await service({ id: 'note_1' })
      .create({ title: 'a', body: '' })
      .catch((error: unknown) => error)) as AppError;

    expect(failure).toBeInstanceOf(AppError);
    expect(failure.message).toMatch(/a note\b/);
  });
});

describe('the service states the request it makes', () => {
  test('list asks for the collection with GET and forwards the abort signal', async () => {
    const calls: Recorded[] = [];
    const controller = new AbortController();
    const service = new NotesService({
      transport: transportReturning({ notes: [], serverTime: 1 }, calls),
    });

    await service.list(controller.signal);

    expect(calls[0]?.path).toBe('/api/notes');
    expect(calls[0]?.options?.method).toBe('GET');
    expect(calls[0]?.options?.signal).toBe(controller.signal);
  });

  test('update addresses one note and encodes the id', async () => {
    const calls: Recorded[] = [];
    const service = new NotesService({ transport: transportReturning(note(), calls) });

    await service.update('note/../other', { title: 'b' });

    // An id is not trusted to be URL-safe: a raw slash would address a different
    // resource, and this is the only place that decides how an id becomes a path.
    expect(calls[0]?.path).toBe('/api/notes/note%2F..%2Fother');
    expect(calls[0]?.options?.method).toBe('PATCH');
  });

  test('remove is a DELETE and expects no body back', async () => {
    const calls: Recorded[] = [];
    const service = new NotesService({ transport: transportReturning(undefined, calls) });

    expect(await service.remove('note_1')).toBeUndefined();
    expect(calls[0]?.path).toBe('/api/notes/note_1');
    expect(calls[0]?.options?.method).toBe('DELETE');
  });
});

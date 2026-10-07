// apps/frontend/client/src/lib/server/notes_service.ts
//
// Notes authorization and persistence. The server service.
//
// The authorization rule for this resource: **a note is reachable only through a
// query that filters on `owner_id` taken from the verified session.** Every read
// and every write below includes it in the same query. A handler that loads a
// note by id and then compares owners is one refactor away from a leak, and the
// mistake survives review because it still looks like a check.
//
// The service takes the owner id as a required argument and has no way to obtain
// one. That is the point of the split: the *route adapter* resolves who the
// caller is, and this file cannot be reached without an answer already, so there
// is no code path in which a note is read or written for a caller nobody
// verified. A method signature that required a `Request` would put the trust
// decision back inside the persistence layer, which is where it does not belong.
//
// Two callers, one implementation:
//   * `src/routes/api/notes/**` — thin HTTP adapters for the browser
//   * `src/routes/notes/+page.server.ts` — the SSR load, which calls this
//     directly and never fetches its own origin
//
// What it returns is the wire DTO, not a database row, so a caller cannot
// accidentally serialize an internal column into page data.

import { notes } from '@starter/database';
import type { Note, NoteCreate, NoteUpdate } from '@starter/schemas/notes';
import { createId } from '@starter/utils';
import { and, desc, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { AppSchema } from './container.ts';

type NoteRow = typeof notes.$inferSelect;

/**
 * The application's Drizzle handle.
 *
 * `DrizzleD1Database` is invariant in its schema parameter, so this cannot be
 * narrowed to a `{ notes }`-only handle: a database built for the full app schema
 * is not assignable to one built for a subset, and the second table set would be a
 * second claim about which tables exist. Naming the app's schema once, in
 * `container.ts`, is what keeps a service from being handed a handle that cannot
 * answer its own queries.
 */
export type NotesDatabase = DrizzleD1Database<AppSchema>;

/** D1 row -> wire shape. D1 stores timestamps as `Date`; the wire uses ms. */
export const toWireNote = (row: NoteRow): Note => ({
  id: row.id,
  ownerId: row.ownerId,
  title: row.title,
  body: row.body,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

/** How many notes one owner's list will return. A bound, not a promise of scale. */
export const MAX_LISTED_NOTES = 200;

export interface NotesService {
  /** One owner's notes, newest first. Never another owner's. */
  list(ownerId: string): Promise<Note[]>;
  /**
   * Create a note for `ownerId`.
   *
   * `ownerId` is a parameter rather than part of `input` on purpose: the create
   * schema has `additionalProperties: false`, so a request body carrying
   * `ownerId` is refused outright rather than accepted-and-ignored. A client that
   * could send it would be able to write into another user's list.
   */
  create(ownerId: string, input: NoteCreate): Promise<Note>;
  /** `null` when no such note exists *for this owner*. Update one otherwise. */
  update(ownerId: string, id: string, input: NoteUpdate): Promise<Note | null>;
  /** `false` when no such note exists *for this owner*. Remove one otherwise. */
  remove(ownerId: string, id: string): Promise<boolean>;
}

export const createNotesService = (db: NotesDatabase): NotesService => ({
  async list(ownerId) {
    // `await`, not `.then()`: a Drizzle query builder is both thenable and
    // async-iterable, so `.then()` widens the result to a union that no longer
    // matches the DTO.
    const rows = await db
      .select()
      .from(notes)
      .where(eq(notes.ownerId, ownerId))
      .orderBy(desc(notes.updatedAt), desc(notes.id))
      .limit(MAX_LISTED_NOTES);
    return rows.map(toWireNote);
  },

  async create(ownerId, input) {
    const now = new Date();
    const row: NoteRow = {
      id: createId('note'),
      ownerId,
      title: input.title,
      body: input.body,
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(notes).values(row);
    return toWireNote(row);
  },

  async update(ownerId, id, input) {
    const rows = await db
      .update(notes)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(notes.id, id), eq(notes.ownerId, ownerId)))
      .returning();

    const row = rows[0];
    return row === undefined ? null : toWireNote(row);
  },

  async remove(ownerId, id) {
    const rows = await db
      .delete(notes)
      .where(and(eq(notes.id, id), eq(notes.ownerId, ownerId)))
      .returning();

    return rows.length > 0;
  },
});

/** Resolve the request's complete backend once; Supabase ids are never sent to D1. */
export const createRequestNotesService = (locals: {
  context: {
    backendProfile: 'legacy' | 'supabase';
    user: { id: string } | null;
    services: import('./supabase_context.ts').ApplicationServices | null;
  };
  container: { db: NotesDatabase };
}): NotesService => {
  if (locals.context.backendProfile === 'legacy') {
    return createNotesService(locals.container.db);
  }
  const identity = locals.context.services?.identity;
  const repository = locals.context.services?.notes;
  if (!identity || !repository || identity.user.id !== locals.context.user?.id) {
    throw new Error("Supabase notes service requires this request's verified Supabase identity.");
  }
  const assertOwner = (ownerId: string) => {
    if (ownerId !== identity.user.id) {
      throw new Error('Supabase notes owner does not match the verified identity.');
    }
  };
  return {
    async list(ownerId) {
      assertOwner(ownerId);
      const listed: Note[] = [];
      let cursor: string | null = null;
      while (listed.length < MAX_LISTED_NOTES) {
        const result = await repository.list(ownerId, cursor);
        listed.push(...result.notes.slice(0, MAX_LISTED_NOTES - listed.length));
        if (!result.hasMore || result.nextCursor === null) {
          break;
        }
        cursor = result.nextCursor;
      }
      return listed;
    },
    async create(ownerId, input) {
      assertOwner(ownerId);
      return repository.create(ownerId, input);
    },
    async update(ownerId, id, input) {
      assertOwner(ownerId);
      return repository.update(ownerId, id, input);
    },
    async remove(ownerId, id) {
      assertOwner(ownerId);
      return repository.remove(ownerId, id);
    },
  };
};

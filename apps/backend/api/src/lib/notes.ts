// apps/backend/api/src/lib/notes.ts
//
// The notes routes.
//
// The authorization rule for this resource: **a note is reachable only through
// a query that filters on `owner_id` taken from the verified session.** Every
// read and every write below includes it in the same query. A handler that
// loads a note by id and then compares owners is one refactor away from a leak,
// and the mistake survives review because it still looks like a check.
//
// Request and response validation are Elysia's job, via the `body` / `response`
// schemas. That is the point of running TypeBox here: one schema validates the
// incoming body, types the handler's `body`, and validates the outgoing
// response — so there is no second hand-written validation to drift.
//
// The container arrives as a parameter and is closed over, rather than read from
// a module variable. Per request, `buildRequestContext` resolves the caller from
// the request in hand; the database handle belongs to the binding set.

import { notes } from '@starter/database';
import {
  NoteCreateSchema,
  NoteListSchema,
  NoteSchema,
  NoteUpdateSchema,
} from '@starter/schemas/notes';
import { createId } from '@starter/utils';
import { and, desc, eq } from 'drizzle-orm';
import { Elysia, status, t } from 'elysia';
import type { Container } from './container.ts';
import { buildRequestContext, unauthorized } from './request_context.ts';

type NoteRow = typeof notes.$inferSelect;

/** D1 row -> wire shape. D1 stores timestamps as `Date`; the wire uses ms. */
export const toWireNote = (row: NoteRow) => ({
  id: row.id,
  ownerId: row.ownerId,
  title: row.title,
  body: row.body,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

const errorBody = t.Object({ error: t.String(), message: t.String() });

/**
 * 404 rather than 403 for a note the caller does not own.
 *
 * The update and delete filters both include `owner_id`, so a note owned by
 * someone else is indistinguishable from one that does not exist. Deliberate: a
 * 403 would confirm the note exists, turning the endpoint into an existence
 * oracle for other users' data.
 */
const notFound = () => status(404, { error: 'not_found', message: 'That note does not exist.' });

export const notesRoutes = (container: Container) =>
  // `/api` prefixed like every other route here. This was once `/notes`, and
  // the mismatch was invisible locally because nothing exercised it: the client
  // called `/api/notes`, the router had `/notes`, and the answer was a 404.
  new Elysia({ name: 'starter/notes' }).group('/api/notes', (group) =>
    group
      .get(
        '/',
        async ({ request }) => {
          const { user } = await buildRequestContext(request, container);
          if (!user) {
            return unauthorized();
          }

          // `await`, not `.then()`: a Drizzle query builder is both thenable
          // and async-iterable, so `.then()` widens the result to a union that
          // no longer matches the declared response schema.
          const rows = await container.db
            .select()
            .from(notes)
            .where(eq(notes.ownerId, user.id))
            .orderBy(desc(notes.updatedAt))
            .limit(200);

          return { notes: rows.map(toWireNote), serverTime: Date.now() };
        },
        { response: { 200: NoteListSchema, 401: errorBody } },
      )

      .post(
        '/',
        async ({ request, body }) => {
          const { user, logger, traceId } = await buildRequestContext(request, container);
          if (!user) {
            return unauthorized();
          }

          const now = new Date();
          const row = {
            id: createId('note'),
            // From the verified session, never from the request body. A client
            // that could send `ownerId` could write into another user's list.
            ownerId: user.id,
            title: body.title,
            body: body.body,
            createdAt: now,
            updatedAt: now,
          };

          await container.db.insert(notes).values(row);
          logger.info('notes.create', { noteId: row.id, traceId });
          return toWireNote(row);
        },
        { body: NoteCreateSchema, response: { 200: NoteSchema, 401: errorBody } },
      )

      .patch(
        '/:id',
        async ({ request, params, body }) => {
          const { user } = await buildRequestContext(request, container);
          if (!user) {
            return unauthorized();
          }

          const rows = await container.db
            .update(notes)
            .set({ ...body, updatedAt: new Date() })
            .where(and(eq(notes.id, params.id), eq(notes.ownerId, user.id)))
            .returning();

          const row = rows[0];
          return row === undefined ? notFound() : toWireNote(row);
        },
        { body: NoteUpdateSchema, response: { 200: NoteSchema, 401: errorBody, 404: errorBody } },
      )

      .delete(
        '/:id',
        async ({ request, params }) => {
          const { user, logger, traceId } = await buildRequestContext(request, container);
          if (!user) {
            return unauthorized();
          }

          const rows = await container.db
            .delete(notes)
            .where(and(eq(notes.id, params.id), eq(notes.ownerId, user.id)))
            .returning();

          if (rows.length === 0) {
            return notFound();
          }

          logger.info('notes.delete', { noteId: params.id, traceId });
          return status(204);
        },
        { response: { 204: t.Void(), 401: errorBody, 404: errorBody } },
      ),
  );

// packages/backend/database/src/lib/chat_tables.ts
//
// The chat tables, kept beside the rest of the schema.
//
// Two tables and a foreign key chain that decides ownership:
//
// `messages.conversation_id` cascades from `conversations`, and `conversations`
// cascades from `users`. That chain is the whole authorization story for a stored
// message: there is no path by which a row survives its owner, and a conversation
// cannot be emptied out from under its messages without the messages going with it.
// Every read additionally filters on the owner, so the cascade is what *enforces*
// the rule rather than what the query merely checks.
//
// There is deliberately **no `status` column**. A message is persisted only once it
// is complete; the half-written assistant turn the browser is rendering lives in the
// response stream and never in the database. See `MESSAGE_STATUSES` in
// `@starter/schemas/chat` for why, and `streamTurn` for the consequence: a turn
// that is dropped mid-stream leaves no row, rather than a row that needs reconciling.

import { sql } from 'drizzle-orm';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { users } from './schema.ts';

/**
 * One conversation.
 *
 * `organizationId` is nullable and *not* a foreign key. An organization is a tenancy
 * concept this template documents rather than implements, and a foreign key to a
 * table nothing writes would make every insert require a row in it. The column
 * exists so the tenancy decision is visible in the schema now rather than discovered
 * later as a migration across every query; it is written only by
 * `apps/frontend/client/src/lib/server/chat_service.ts`.
 */
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    /** FK to `users.id`. Cascade: deleting an account deletes its conversations. */
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    organizationId: text('organization_id'),
    title: text('title').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('conversations_owner_updated_idx').on(table.ownerId, table.updatedAt),
    index('conversations_owner_id_idx').on(table.ownerId),
  ],
);

/**
 * One message.
 *
 * `clientId` is the caller's own id for the message, carried so a client can
 * reconcile the row it rendered optimistically with the row the server stored, and
 * so a retry after a dropped connection is recognisable as the same submission.
 * Uniquely indexed per conversation rather than merely stored, because two
 * submissions of the same client id *are* the same submission — that is what turns a
 * retry from a duplicate into a read.
 */
export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    /** FK to `conversations.id`. Cascade: a conversation cannot outlive its messages. */
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    authorId: text('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `user` | `assistant`. Enforced by the request schema, not by this column. */
    role: text('role').notNull(),
    content: text('content').notNull(),
    /**
     * The caller's own id for this message. Unique per conversation, so a retry
     * after a dropped connection is recognisable as the same submission rather than
     * written a second time.
     */
    clientId: text('client_id').notNull(),
    /** Epoch milliseconds, as an integer. D1 is SQLite; `Date` is Drizzle's view. */
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (table) => [
    index('messages_conversation_created_idx').on(table.conversationId, table.createdAt),
    uniqueIndex('messages_client_id_idx').on(table.conversationId, table.clientId),
  ],
);

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;

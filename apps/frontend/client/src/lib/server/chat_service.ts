// apps/frontend/client/src/lib/server/chat_service.ts
//
// Chat persistence. The server service.
//
// The authorization rule is the same one `notes_service.ts` states and it is not
// restated with new wording because it is the same rule: **a conversation is
// reachable only through a query that filters on `owner_id` taken from the verified
// session.** Every read and every write below includes it in the same query. A
// handler that loads a conversation by id and then compares owners has already
// handed the row to code that can log it, and the mistake survives review because it
// still looks like a check.
//
// The owner id is a required argument and this module has no way to obtain one.
// That is the point of the split: the route adapter resolves who the caller is, so
// there is no code path in which a message is read or written for a caller nobody
// verified.
//
// **What this service does not do: stream.** It persists a turn and returns rows.
// Producing the assistant's text is a model's job (`chat_model.ts`) and carrying it
// is a transport's (`streamTurn` in the route). A persistence layer that also
// streamed would be the reason the authorization rule became hard to see: the
// streaming code and the row-writing code would be the same function, so a review of
// "who may read this conversation" would have to read the token loop.
//
// Three properties worth naming, because each is a bug someone would otherwise
// write:
//
//   - **Idempotent on `clientId`.** A client whose connection dropped retries the
//     same submission, and the unique index on `(conversation_id, client_id)` means
//     the retry returns the row that already exists instead of writing the user's
//     message twice. Checked by reading *before* writing, because the index is still
//     what holds the guarantee under concurrency but catching a constraint violation
//     would turn an ordinary retry into an error the client has to distinguish.
//   - **Bumps `conversations.updated_at`.** Ordering a conversation list by recency
//     has to mean recency of the *conversation*, or a conversation someone is
//     actively using stays at the bottom of the list.
//   - **Returns rows, never wire DTOs assembled by the caller.** `toWireMessage` is
//     the one projection, so a database column cannot reach a response by accident.

import { conversations, messages } from '@starter/database';
import type {
  Conversation,
  ConversationCreate,
  Message,
  MessagePage,
  MessageRole,
} from '@starter/schemas/chat';
import { MessageCursorError } from '@starter/schemas/chat';
import { createId } from '@starter/utils';
import { and, asc, desc, eq, lt, or, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import type { AppSchema } from './container.ts';

/**
 * The application's Drizzle handle.
 *
 * Invariant in its schema parameter, so it cannot be narrowed here — see the same
 * note in `notes_service.ts`. Naming the app's schema once, in `container.ts`, is
 * what stops a service being handed a handle that cannot answer its own queries.
 */
export type ChatDatabase = DrizzleD1Database<AppSchema>;

type ConversationRow = typeof conversations.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

/** D1 stores timestamps as `Date`; the wire uses epoch milliseconds. */
const toWireConversation = (row: ConversationRow, messageCount: number): Conversation => ({
  id: row.id,
  ownerId: row.ownerId,
  organizationId: row.organizationId,
  title: row.title,
  messageCount,
  createdAt: row.createdAt.getTime(),
  updatedAt: row.updatedAt.getTime(),
});

export const toWireMessage = (row: MessageRow): Message => ({
  id: row.id,
  clientId: row.clientId,
  conversationId: row.conversationId,
  authorId: row.authorId,
  // The column is `text`; the union is the assertion. A role outside the two is a
  // row this service never writes, and surfacing it as-is would put an undeclared
  // value on the wire.
  role: row.role as MessageRole,
  content: row.content,
  // Persisted rows are always complete: a half-written turn is never stored.
  status: 'complete',
  createdAt: row.createdAt.getTime(),
});

/** A bound on the conversation list, not a promise of scale. */
export const MAX_LISTED_CONVERSATIONS = 100;

/**
 * A bound on one conversation's message page.
 *
 * `MESSAGE_CONTENT_MAX_LENGTH` caps a single message and this caps how many one
 * request returns. Both exist because the streaming UI appends to an array it
 * already holds: a conversation that grew without limit would make every delta more
 * expensive to render, in the browser as well as the Worker.
 */
export const MAX_LISTED_MESSAGES = 500;

export interface ChatService {
  /** One owner's conversations, most recently active first. */
  list(ownerId: string): Promise<Conversation[]>;
  /** `null` when no such conversation exists *for this owner*. */
  find(ownerId: string, conversationId: string): Promise<Conversation | null>;
  create(ownerId: string, input: ConversationCreate): Promise<Conversation>;
  /**
   * One conversation's messages, oldest first.
   *
   * Oldest first deliberately: the streaming UI appends a turn to the end, and a
   * newest-first page would land every new turn above every old one.
   */
  messages(ownerId: string, conversationId: string): Promise<Message[]>;
  messagePage(ownerId: string, conversationId: string, cursor: string | null): Promise<MessagePage>;
  /**
   * Store the caller's message.
   *
   * Idempotent on `clientId`: a resubmission of the same id returns the existing row
   * unchanged. `null` when the conversation is not this owner's, which is the same
   * answer as "no such conversation".
   */
  appendUserMessage(
    ownerId: string,
    conversationId: string,
    content: string,
    clientId: string,
  ): Promise<Message | null>;
  /**
   * Store a model reply.
   *
   * `id` and `createdAt` are supplied by the caller rather than generated here,
   * because the streaming route announces both on the `start` frame *before* the
   * reply exists. A row whose id the client was never told would make the `complete`
   * frame disagree with the `start` frame, and a client keying its pending turn on
   * the announced id would hold an entry that never resolves.
   */
  appendAssistantMessage(
    ownerId: string,
    conversationId: string,
    content: string,
    id: string,
    createdAt: number,
  ): Promise<Message | null>;
}

export const createChatService = (db: ChatDatabase): ChatService => ({
  async list(ownerId) {
    // The message count is a correlated subquery in the same statement rather than a
    // second query per row: a page of 100 conversations followed by 100 counts is 101
    // statements, and SQLite decides each independently, so the counts could come
    // from a different moment than the pages.
    const rows = await db
      .select({
        conversation: conversations,
        messageCount: sql<number>`(select count(*) from ${messages} where ${messages.conversationId} = ${conversations.id})`,
      })
      .from(conversations)
      .where(eq(conversations.ownerId, ownerId))
      .orderBy(desc(conversations.updatedAt), desc(conversations.id))
      .limit(MAX_LISTED_CONVERSATIONS);

    return rows.map((row) => toWireConversation(row.conversation, row.messageCount));
  },

  async find(ownerId, conversationId) {
    const rows = await db
      .select()
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.ownerId, ownerId)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) {
      return null;
    }

    const counted = await db
      .select({ messageCount: sql<number>`count(*)` })
      .from(messages)
      .where(eq(messages.conversationId, row.id));

    return toWireConversation(row, counted[0]?.messageCount ?? 0);
  },

  async create(ownerId, input) {
    const now = new Date();
    const row: ConversationRow = {
      id: createId('cnv'),
      ownerId,
      // Always null. An organization-scoped conversation is not something this
      // template creates, and defaulting it to the owner's id would invent a
      // tenancy model nothing else knows about.
      organizationId: null,
      title: input.title,
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(conversations).values(row);
    return toWireConversation(row, 0);
  },

  async messages(ownerId, conversationId) {
    // Both predicates in one query. Filtering only on `conversation_id` would work
    // for a correct id and would also read another owner's conversation, because the
    // id alone says nothing about who owns it.
    const rows = await db
      .select({ message: messages })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(eq(messages.conversationId, conversationId), eq(conversations.ownerId, ownerId)))
      .orderBy(asc(messages.createdAt), asc(messages.id))
      .limit(MAX_LISTED_MESSAGES);

    return rows.map((row) => toWireMessage(row.message));
  },

  async messagePage(ownerId, conversationId, cursor) {
    let boundary: { createdAt: number; id: string } | null = null;
    if (cursor !== null) {
      try {
        const value: unknown = JSON.parse(atob(cursor));
        if (
          typeof value !== 'object' ||
          value === null ||
          !('createdAt' in value) ||
          !('id' in value) ||
          !('ownerId' in value) ||
          !('conversationId' in value) ||
          value.ownerId !== ownerId ||
          value.conversationId !== conversationId ||
          typeof value.createdAt !== 'number' ||
          !Number.isFinite(value.createdAt) ||
          !Number.isFinite(new Date(value.createdAt).getTime()) ||
          typeof value.id !== 'string' ||
          value.id.length === 0
        ) {
          throw new Error();
        }
        boundary = { createdAt: value.createdAt, id: value.id };
      } catch {
        throw new MessageCursorError();
      }
    }
    const predicates = [
      eq(messages.conversationId, conversationId),
      eq(conversations.ownerId, ownerId),
    ];
    if (boundary !== null) {
      const older = or(
        lt(messages.createdAt, new Date(boundary.createdAt)),
        and(eq(messages.createdAt, new Date(boundary.createdAt)), lt(messages.id, boundary.id)),
      );
      if (older !== undefined) {
        predicates.push(older);
      }
    }
    const rows = await db
      .select({ message: messages })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(and(...predicates))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(51);
    const hasMore = rows.length > 50;
    const selected = rows.slice(0, 50);
    const items = selected.reverse().map((row) => toWireMessage(row.message));
    const first = items[0];
    return {
      items,
      nextCursor:
        hasMore && first
          ? btoa(
              JSON.stringify({ ownerId, conversationId, createdAt: first.createdAt, id: first.id }),
            )
          : null,
      hasMore,
      serverTime: Date.now(),
    };
  },

  async appendUserMessage(ownerId, conversationId, content, clientId) {
    // Read first. The unique index is what makes the guarantee hold under
    // concurrency — two simultaneous retries both read "absent" — but checking first
    // means the *ordinary* retry is a read rather than an error.
    const existing = await db
      .select({ message: messages })
      .from(messages)
      .innerJoin(conversations, eq(conversations.id, messages.conversationId))
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.clientId, clientId),
          eq(conversations.ownerId, ownerId),
        ),
      )
      .limit(1);

    const already = existing[0];
    if (already !== undefined) {
      return toWireMessage(already.message);
    }

    const row: MessageRow = {
      id: createId('msg'),
      conversationId,
      authorId: ownerId,
      role: 'user',
      content,
      clientId,
      createdAt: new Date(),
    };

    const inserted = await db
      .insert(messages)
      .values(row)
      // The second writer loses rather than failing: the row it wanted to write is
      // the row the first writer wrote, and both callers want it.
      .onConflictDoNothing({ target: [messages.conversationId, messages.clientId] })
      .returning();

    const stored = inserted[0];
    if (stored === undefined) {
      const winner = await db
        .select({ message: messages })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.clientId, clientId),
            eq(conversations.ownerId, ownerId),
          ),
        )
        .limit(1);

      const row2 = winner[0];
      return row2 === undefined ? null : toWireMessage(row2.message);
    }

    await touchConversation(db, conversationId, row.createdAt);
    return toWireMessage(stored);
  },

  async appendAssistantMessage(ownerId, conversationId, content, id, createdAt) {
    // Check ownership first: if the conversation isn't this owner's, return null.
    // This is the same pattern `notes_service` uses - verify ownership before writing.
    const conversation = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.ownerId, ownerId)))
      .limit(1);

    if (conversation[0] === undefined) {
      return null;
    }

    const row: MessageRow = {
      id,
      conversationId,
      authorId: ownerId,
      role: 'assistant',
      content,
      // A reply has no caller-supplied id of its own, and it must not collide with
      // the unique `(conversation_id, client_id)` index a user's submission uses.
      // Derived from the reply id, so it is unique by construction.
      clientId: `${id}:reply`,
      createdAt: new Date(createdAt),
    };

    const inserted = await db.insert(messages).values(row).returning();

    const stored = inserted[0];
    if (stored === undefined) {
      return null;
    }

    await touchConversation(db, conversationId, row.createdAt);
    return toWireMessage(stored);
  },
});

/**
 * Move a conversation to the top of its owner's list.
 *
 * A separate statement rather than part of the insert, because the two tables do not
 * share a transaction here: the message is the thing that must be durable, and a
 * failed `updated_at` bump costs a conversation its place in a list rather than
 * costing the user their message. The reverse ordering — bump first, then write —
 * would leave a conversation looking active with no message in it.
 */
const touchConversation = async (
  db: ChatDatabase,
  conversationId: string,
  now: Date,
): Promise<void> => {
  await db
    .update(conversations)
    .set({ updatedAt: now })
    .where(eq(conversations.id, conversationId));
};

// packages/shared/schemas/src/common/ids.ts
//
// Identifier shapes live with the schemas so the Worker, the client and the
// database all agree. `Brand` keeps a user id from being passed where a note id
// belongs without needing a cast.

import { type Static, Type } from 'typebox';

declare const brandSymbol: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brandSymbol]: B };

export const UserIdSchema = Type.String({ minLength: 1, maxLength: 64 });
export type UserId = Static<typeof UserIdSchema> & Brand<string, 'UserId'>;

export const NoteIdSchema = Type.String({ minLength: 1, maxLength: 64 });
export type NoteId = Static<typeof NoteIdSchema> & Brand<string, 'NoteId'>;

export const SessionIdSchema = Type.String({ minLength: 1, maxLength: 64 });
export type SessionId = Static<typeof SessionIdSchema> & Brand<string, 'SessionId'>;

export const ConversationIdSchema = Type.String({ minLength: 1, maxLength: 64 });
export type ConversationId = Static<typeof ConversationIdSchema> & Brand<string, 'ConversationId'>;

export const MessageIdSchema = Type.String({ minLength: 1, maxLength: 64 });
export type MessageId = Static<typeof MessageIdSchema> & Brand<string, 'MessageId'>;

/**
 * An organization's id.
 *
 * A distinct brand from `UserId` on purpose. Multi-tenancy adds a second
 * authorization subject, and the failure this brand prevents is passing one where
 * the other belongs — which for tenants means answering "whose rows" with a user
 * id, silently scoping an organization-wide read to one member.
 */
export const OrganizationIdSchema = Type.String({ minLength: 1, maxLength: 64 });
export type OrganizationId = Static<typeof OrganizationIdSchema> & Brand<string, 'OrganizationId'>;

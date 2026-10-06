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

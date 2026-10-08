import * as v from 'valibot';

declare const brandSymbol: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brandSymbol]: B };

const resourceId = v.pipe(v.string(), v.minLength(1), v.maxLength(64));
export const UserIdSchema = v.pipe(v.string(), v.uuid());
export type UserId = v.InferOutput<typeof UserIdSchema> & Brand<string, 'UserId'>;
export const NoteIdSchema = resourceId;
export type NoteId = v.InferOutput<typeof NoteIdSchema> & Brand<string, 'NoteId'>;
export const SessionIdSchema = resourceId;
export type SessionId = v.InferOutput<typeof SessionIdSchema> & Brand<string, 'SessionId'>;
export const ConversationIdSchema = resourceId;
export type ConversationId = v.InferOutput<typeof ConversationIdSchema> &
  Brand<string, 'ConversationId'>;
export const MessageIdSchema = resourceId;
export type MessageId = v.InferOutput<typeof MessageIdSchema> & Brand<string, 'MessageId'>;
export const OrganizationIdSchema = resourceId;
export type OrganizationId = v.InferOutput<typeof OrganizationIdSchema> &
  Brand<string, 'OrganizationId'>;

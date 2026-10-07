// apps/frontend/client/src/routes/api/chat/conversations/+server.ts
//
// Thin HTTP adapter: resolve identity, call the service, map a result to a status.
//
// `locals.user` was resolved by the composition root in `hooks.server.ts`. This
// handler does not build a request context, because doing so would resolve the same
// session twice on the read path.
//
// The list response is annotated with the schema's own `Static` type, so a change
// to the published wire shape that is not a change to what the service returns is a
// compile error here rather than a client rendering a list of nothing. It does not
// re-validate: the rows came from `toWireConversation`, the single
// projection that decides their shape, and validating again per request would be a
// second definition of the same contract to keep in step.

import {
  type Conversation,
  ConversationCreateSchema,
  type ConversationList,
} from '@starter/schemas/chat';
import { createChatService } from '#lib/server/chat_service.ts';
import { json, jsonError, readJsonBody, unauthorized } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

/** A create body is one field; a conversation title is 120 characters. */
const MAX_CREATE_BODY_BYTES = 4096;

/** A 200 body, typed as what `ConversationListSchema` describes. */
const conversationList = (conversations: Conversation[]): ConversationList => ({
  conversations,
  serverTime: Date.now(),
});

export const GET: RequestHandler = async ({ locals }) => {
  const user = locals.user;
  if (user === null) {
    return unauthorized();
  }

  return json(200, conversationList(await createChatService(locals.container.db).list(user.id)));
};

export const POST: RequestHandler = async ({ locals, request }) => {
  const user = locals.user;
  if (user === null) {
    return unauthorized();
  }

  const body = await readJsonBody(request, ConversationCreateSchema, {
    maxBytes: MAX_CREATE_BODY_BYTES,
  });
  if (!body.ok) {
    return body.response;
  }

  const created = await createChatService(locals.container.db).create(user.id, body.value);

  return json(201, created);
};

/**
 * The unsupported verbs.
 *
 * A JSON 405 beats a framework-generated 405 page, because every other refusal on
 * this origin is the same `{ error, message }` shape and a client cannot handle two
 * error formats.
 */
export const PUT: RequestHandler = async () =>
  jsonError(405, 'method_not_allowed', 'Use POST to create a conversation.');

export const DELETE: RequestHandler = async () =>
  jsonError(405, 'method_not_allowed', 'Use DELETE on one conversation.');

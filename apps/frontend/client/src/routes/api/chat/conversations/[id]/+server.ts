// apps/frontend/client/src/routes/api/chat/conversations/[id]/+server.ts
//
// Thin HTTP adapter: resolve identity, call the service, map a result to a status.
//
// `locals.user` was resolved by the composition root in `hooks.server.ts`.

import { createRequestChatService } from '#lib/server/application_chat.ts';
import { json, jsonError, unauthorized } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ locals, params }) => {
  const user = locals.user;
  if (user === null) {
    return unauthorized();
  }

  const conversation = await createRequestChatService(locals).find(user.id, params.id);
  if (conversation === null) {
    return jsonError(404, 'not_found', 'That conversation does not exist.');
  }

  return json(200, conversation);
};

/** The unsupported verbs. */
export const POST: RequestHandler = async () =>
  jsonError(405, 'method_not_allowed', 'Use POST on /api/chat/conversations to create.');

export const PUT: RequestHandler = async () =>
  jsonError(405, 'method_not_allowed', 'Conversations cannot be updated via this route.');

export const DELETE: RequestHandler = async () =>
  jsonError(405, 'method_not_allowed', 'Use DELETE on one conversation to remove it.');

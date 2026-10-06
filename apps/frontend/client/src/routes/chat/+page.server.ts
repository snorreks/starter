// apps/frontend/client/src/routes/chat/+page.server.ts
//
// The conversation list.
//
// Load only. There is deliberately **no `actions` export here**: this application has
// one mutation path and it is `/api/*`, so that one rule per write means one place to
// be right. "Start a new conversation" posts to `/api/chat/conversations` from the
// browser and then navigates to the result — see `ChatListViewModel.create`.
//
// The load calls the chat service directly for the same reason `notes` does: a server
// load that HTTP-fetches its own origin is a second, differently authenticated path in
// front of the same data.

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { createChatService } from '#lib/server/chat_service.ts';

export const load: PageServerLoad = async ({ locals }) => {
  const user = locals.user;
  if (user === null) {
    // A redirect rather than an empty list: an empty list renders as "you have no
    // conversations" to a signed-out visitor, which is a different and wrong claim.
    redirect(303, '/login');
  }

  return {
    conversations: await createChatService(locals.container.db).list(user.id),
    serverTime: Date.now(),
  };
};
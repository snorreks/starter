// apps/frontend/client/src/routes/chat/[id]/+page.server.ts
//
// The SSR load for one conversation.
//
// It calls the service **directly**, not through `fetch('/api/chat/...')`. The second
// shape would be a second, differently-authenticated path in front of the same data: a
// round trip from inside the process that serves `/api/chat`, an extra hop on every
// page render, and in `vite dev` an exercise of the emulated binding set over HTTP to
// reach the process that already holds it.
//
// Ownership is enforced in the query, so a conversation belonging to somebody else
// returns `null` and becomes the same 404 an unknown id would. A 403 would confirm
// that it exists, turning this page into an existence oracle for other users' data.

import { error, redirect } from '@sveltejs/kit';
import { createChatService } from '#lib/server/chat_service.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const user = locals.user;
  if (user === null) {
    // A redirect rather than a 403: this page is only reachable signed in, and the
    // sign-in page is where an anonymous visitor belongs. `next` is what returns them
    // to this conversation afterwards, encoded because it is a path interpolated into
    // a query string.
    redirect(307, `/login?next=${encodeURIComponent(url.pathname)}`);
  }

  const service = createChatService(locals.container.db);
  const conversation = await service.find(user.id, params.id);
  if (conversation === null) {
    throw error(404, 'That conversation does not exist.');
  }

  return {
    conversation,
    // The history travels with the page so the first paint is the whole transcript
    // rather than a spinner. The ViewModel is seeded with it and does not re-fetch.
    messages: await service.messages(user.id, params.id),
  };
};

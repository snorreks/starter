// apps/frontend/client/src/routes/notes/+page.server.ts
//
// The authenticated notes route's server load.
//
// Three properties this file is responsible for, and each is a specific failure it
// prevents:
//
//   1. **It calls the notes service directly.** Not `fetch('/api/notes')`. A server
//      load that HTTP-fetches its own origin adds a second identity path, a
//      network hop to itself, and a failure mode where a cookie that works in the
//      browser does not reach a loopback fetch. The service is one call away, and
//      the browser still has `/api/notes` for its own mutations — same service,
//      two adapters, one authorization rule.
//
//   2. **It returns DTOs, not rows.** The `Note` shape is the wire shape, so there
//      is no database column that can leak into page data by accident. The session
//      token, the bindings and the container are never in scope here: `locals.user`
//      arrives as three already-selected fields from the layout load.
//
//   3. **An anonymous request is redirected, not rendered.** The alternative is an
//      empty notes screen that reads as "you have no notes" to a signed-out
//      visitor, which is the same confusion an HTTP 200 with an empty list causes.

import { redirect } from '@sveltejs/kit';
import { createRequestNotesService } from '#lib/server/notes_service.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
  const user = locals.user;
  if (user === null) {
    redirect(303, '/login');
  }

  const notes = await createRequestNotesService(locals).list(user.id);
  return { notes, serverTime: Date.now(), remote: true };
};

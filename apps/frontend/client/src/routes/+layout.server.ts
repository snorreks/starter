// apps/frontend/client/src/routes/+layout.server.ts
//
// The one piece of state every page needs: who, if anyone, is signed in.
//
// Resolved here rather than in each page's own load because `locals.user` is
// already the verified answer — re-resolving it per page would be a second
// session lookup per navigation and a second place for identity to come from.
//
// The DTO is `RequestUser`, which is already three explicitly named fields. That is
// the point of building it that way in `#lib/server/request_context.ts` rather than
// returning `session.user` from here: Supabase Auth's user object carries `image`,
// `emailVerified` and its session object carries a token, and this load's result is
// serialized into the HTML. Selecting the shape once, at the boundary, means a new
// Supabase Auth field cannot reach a page by default.

import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => ({ user: locals.user });

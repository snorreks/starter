// apps/frontend/client/src/lib/composition/session.ts
//
// The web application's session: one state object and one service.
//
// The session is genuinely global *in a browser* — one writer, many readers, and
// two screens disagreeing about who is signed in is a bug the user sees at once.
// So it is a singleton here, in a browser module, and the route that seeds it is
// explicit about when.
//
// It is a singleton *here* rather than in `@starter/features` on purpose. A
// module-scope `new SessionState()` inside the shared package would be one object
// for the whole Worker isolate: two concurrent SSR requests would read and write
// the same identity, and the second would render the first one's account. That is
// the failure per-request identity exists to prevent, and the only way to prevent
// it is for the shared code to have no instance of its own.

import { AuthSessionService, createAccountService, SessionState } from '@starter/features/auth';
import type { Navigation } from '@starter/platform';
import { goto, invalidateAll } from '$app/navigation';
import { webTransport } from './transport.ts';

export const sessionState = new SessionState();

export const sessionService = new AuthSessionService({
  transport: webTransport,
  state: sessionState,
});

export const accountService = createAccountService(webTransport);

/**
 * Navigation, with the one web-only rule in it.
 *
 * `invalidateAll()` before `goto` is not politeness. After a sign-in the server
 * has to re-render: the layout load carries the user, and `/notes` redirects on its
 * own load against the session the browser already holds. A client-side `goto`
 * alone navigates to a page whose server load would run against the *previous*
 * answer, which reads as a page that forgot you signed in.
 */
export const webNavigation: Navigation = {
  go: async (path: string) => {
    await invalidateAll();
    await goto(path);
  },
};

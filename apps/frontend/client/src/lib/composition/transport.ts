// apps/frontend/client/src/lib/composition/transport.ts
//
// The web application's answers to the platform contracts.
//
// This file is the seam. Everything below it — the notes service, the account
// endpoints, the session, the ViewModels, the components — is host-independent
// code in `@starter/features`, and everything above it is a route that renders
// something. The only host facts in the whole frontend are the four here.
//
// Each answer is a *composition root*, which means a value constructed here
// rather than found. A native shell constructs four different ones and changes
// nothing else, which is the property the shared packages exist to have.
//
// Why one transport instance for the app
// --------------------------------------
// Base URL and credentials are per-request decisions the transport already takes
// from its options; there is no per-call state to share. So one instance is not a
// shortcut around a missing seam — it is the honest shape of a stateless object.

import { HttpTransport } from '@starter/platform';
import { clientConfig } from '#lib/runtime/config.ts';

/**
 * The single HTTP transport the browser uses.
 *
 * `credentials: 'include'` is the whole web session. The Worker serves the HTML,
 * the assets and `/api/*` from one origin, so a relative URL with the cookie
 * attached behaves identically in `vite dev` and on the deployed origin — which
 * is what makes local sign-in a rehearsal of deployed sign-in rather than a
 * different thing that happens to work.
 */
export const webTransport = new HttpTransport({
  baseUrl: clientConfig.apiBaseUrl,
  credentials: 'include',
  className: 'WebApiTransport',
});

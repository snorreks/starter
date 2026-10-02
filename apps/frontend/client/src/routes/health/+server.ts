// apps/frontend/client/src/routes/health/+server.ts
//
// Liveness, and the release's own account of itself.
//
// Public, unauthenticated, and `no-store`. Three reasons, each load-bearing:
//
//   * **Public**, because the deploy pipeline verifies the release by fetching it
//     (`bun run deploy verify`), and because a load balancer needs it before it
//     has decided which release is healthy. It exposes nothing: the release id is
//     the commit under review, the environment is a word, and there is no
//     configuration, no binding value and no stack trace in the body.
//
//   * **`no-store`**, because a cached answer to "what is serving right now" is
//     the *previous* answer. That is worse than no answer, because it looks like a
//     fresh one.
//
//   * **Separate from `/health/ready`**, because the two answer different
//     questions and merging them forces a choice that is always wrong somewhere.
//     Liveness here must not touch the database: a load balancer polling a
//     database-backed probe couples routing health to database latency, and a slow
//     query would pull every Worker out of rotation while the application still
//     serves fine. See `#lib/server/release.ts`.
//
// It is a `+server.ts` and not a page, so it is JSON and never the HTML shell: a
// checker that receives an SPA document has to guess whether the deploy worked.
//
// `Response.json` rather than `json()` from `#lib/server/http.ts`, because that
// helper exists to give every *error* the same shape and takes no headers. A
// health response is not an error and its distinguishing property is its cache
// policy, so the one place that owns that policy is here.

import { healthHeaders, releaseIdentity } from '#lib/server/release.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) =>
  Response.json(releaseIdentity(locals.container), {
    headers: { ...healthHeaders, 'content-type': 'application/json; charset=utf-8' },
  });

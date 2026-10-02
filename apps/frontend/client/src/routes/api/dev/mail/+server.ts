// apps/frontend/client/src/routes/api/dev/mail/+server.ts
//
// `/api/dev/mail` — read the local capture inbox.
//
// This is the fixture mail transport, and it exists so the account lifecycle can
// be exercised end to end without sending anything to anybody. Every test that
// proves verification or recovery works reads its link from here.
//
// Three refusals, each load-bearing:
//
//   1. **Local only.** `403` outside a local environment. A deployed Worker must
//      have no way to read a message, and equally no way to *appear* to have
//      captured one — the failure being guarded against is a deployment whose
//      verification mail goes to a process nobody is reading.
//   2. **No mutation.** `GET` only. This endpoint cannot be used to make the
//      application send a verification mail; `/api/auth/send-verification-email`
//      is the only way to ask for one, and it is rate limited.
//   3. **Same run only.** The inbox is namespaced by `TEST_RUN_ID`, and that id is
//      echoed in every response. A caller can tell whether it is looking at its
//      own run's mail, so a stale message from an earlier run cannot be mistaken
//      for a fresh one.
//
// The body is the message as it would have been sent, including the token. That
// is the point of the endpoint, and it is why the endpoint only exists locally —
// a token is a bearer credential, and this route hands it out on request.

import { json, jsonError } from '#lib/server/http.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, url }) => {
  const { container } = locals;

  if (!container.isLocal) {
    // Named plainly rather than 404: an operator who reaches this on a deployed
    // environment should be told it is refused, not left wondering whether the
    // route exists.
    return jsonError(
      403,
      'not_available',
      'The mail capture inbox is a local-only capability. Deployed environments deliver ' +
        'through Resend and have no inbox to read.',
    );
  }

  const capture = container.mailCapture;
  if (capture === undefined) {
    // Only reachable if `isLocal` and the mail mode disagree, which `resolveMail`
    // makes impossible. Reported rather than thrown so the mismatch is visible.
    return jsonError(503, 'mail_unavailable', 'No mail inbox is configured for this run.');
  }

  const to = url.searchParams.get('to');
  const messages =
    to === null
      ? capture.inbox()
      : [capture.latestFor(to)].filter(
          (message): message is NonNullable<typeof message> => message !== undefined,
        );

  return json(200, {
    mode: capture.mode,
    // Echoed so a harness can prove the inbox it is reading belongs to its own
    // run rather than to a leftover container.
    inbox: capture.inboxId,
    messages: [...messages],
  });
};

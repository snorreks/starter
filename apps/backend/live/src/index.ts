// apps/backend/live/src/index.ts
//
// The live Worker: one upgrade endpoint and one internal publish port.
//
// This Worker exists because SvelteKit cannot serve a WebSocket upgrade, and
// because the alternative — teaching the application's Worker to own its own
// entry point — would mean forking generated adapter output that is replaced on
// every build. So the socket lives here, the data does not, and the two meet at a
// Durable Object that both can reach.
//
// The division of authority is the whole design:
//
//   - **This Worker** decides who is allowed to connect. It holds the ticket
//     signing secret, verifies the credential in the handshake, and owns the
//     sockets. It holds no Supabase credential, reads no message, and writes
//     nothing.
//   - **The application Worker** decides what a subscriber may watch. Every topic
//     is authorized through it, against a verified session and the same owner
//     check its own reads perform.
//   - **The Durable Object** holds the connections and fans out invalidations.
//     It stores no message and answers no read.
//
// Nothing here reaches Postgres. A compromised live Worker leaks the fact that
// somebody is online; it does not leak what they said.

import { LIVE_PROTOCOL, type VerifyLiveTicketResult, verifyLiveTicket } from '@starter/auth/live';
import { LiveHub } from './hub.ts';
import { liveUpgradeHeaders } from './protocol.ts';

export { liveUpgradeHeaders } from './protocol.ts';

export { LiveHub };

export interface LiveEnv {
  /**
   * The secret the application Worker signs tickets with.
   *
   * A secret, and checked for presence at the point of use rather than defaulted:
   * a Worker that quietly signed tickets with an empty key would accept anything.
   */
  readonly LIVE_TICKET_SECRET?: string;
  /** One object per user, named by the application through the same identity. */
  readonly LIVE_HUB?: DurableObjectNamespace;
}

const json = (body: unknown, status: number): Response =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** Why a connection was refused, in terms the operator can act on. */
const REFUSAL_STATUS: Record<Exclude<VerifyLiveTicketResult, { ok: true }>['reason'], number> = {
  'not-offered': 400,
  malformed: 400,
  'bad-signature': 401,
  expired: 401,
  'unsupported-protocol': 400,
};

export default {
  async fetch(request: Request, env: LiveEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'live' }, 200);
    }

    if (url.pathname !== '/live') {
      return json({ error: 'not_found', message: 'No such endpoint.' }, 404);
    }

    const secret = env.LIVE_TICKET_SECRET;
    if (secret === undefined || secret.length < 32) {
      // Refused rather than degraded. Without this secret every handshake would be
      // unverifiable, and "accept them anyway" is the same as having no
      // authentication at all — only quieter.
      return json(
        {
          error: 'not_configured',
          message: 'LIVE_TICKET_SECRET is missing or too short, so no socket can be verified.',
        },
        503,
      );
    }

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      // A plain GET on the socket endpoint is a misconfigured client or a health
      // check hitting the wrong path. 426 rather than 404: the route exists, this
      // request just cannot use it.
      return json(
        { error: 'upgrade_required', message: 'This endpoint requires a WebSocket upgrade.' },
        426,
      );
    }

    const offered = (request.headers.get('sec-websocket-protocol') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    const verdict = await verifyLiveTicket({ secret, offeredProtocols: offered });
    if (!verdict.ok) {
      return json(
        { error: verdict.reason, message: 'This socket could not be authorized.' },
        REFUSAL_STATUS[verdict.reason],
      );
    }

    if (env.LIVE_HUB === undefined) {
      return json(
        { error: 'not_configured', message: 'LIVE_HUB is not bound, so no socket can be held.' },
        503,
      );
    }

    const id = env.LIVE_HUB.idFromName(verdict.userId);
    const response = await env.LIVE_HUB.get(id).fetch('https://live.internal/attach', {
      headers: { upgrade: 'websocket', 'x-live-user': verdict.userId, ...liveUpgradeHeaders() },
    });
    if (response.status !== 101) {
      return response;
    }
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(liveUpgradeHeaders())) {
      headers.set(name, value);
    }
    return new Response(null, { status: 101, webSocket: response.webSocket, headers });
  },
} satisfies ExportedHandler<LiveEnv>;

/** Named so the application Worker's `wrangler.jsonc` binding can find it. */
export const LIVE_WORKER_PROTOCOL = LIVE_PROTOCOL;

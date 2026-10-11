// apps/backend/live/src/hub.ts
//
// The Durable Object: connections in, invalidations out.
//
// **What this is.** One object per user. It holds that user's sockets, remembers
// what each is watching, and fans a published invalidation out to them. It is a
// *coordinator*, not a database: it stores no message, answers no read, and holds
// no Supabase credential. Postgres is the source of truth and the only copy of
// anything.
//
// **What travels.** A topic name and nothing else. The browser that receives
// `conversation:abc` re-reads the conversation through the application it is
// already authenticated to. There is no payload to trust, no row to re-authorize,
// and no way for a notification to become a second copy of the data.
//
// **Why hibernation.** `state.acceptWebSocket` hands the socket to the runtime's
// own store, so an object with sockets attached but nothing to say costs storage,
// not duration — and Cloudflare does not bill an idle hibernated object the way it
// bills a running one. The trade is the rule that follows: a hibernated object has
// no memory of its own between events, so the tags live in
// `state.getWebSockets()`, and any per-connection state that must survive has to be
// in the socket's own attributes. That is why the identity is attached *to the
// socket* rather than kept in a map on this instance.
//
// **Why a subscription is authorized here and not at the upgrade.** The upgrade
// proves only *who* is connecting. What they may watch is a separate question that
// changes per topic, and answering it needs the owner check that only the
// application — with its verified session and its RLS-scoped reads — can perform.
// So a subscribe is forwarded and the object holds nothing until it is answered.

import { DurableObject } from 'cloudflare:workers';
import { invalidateFrame, liveUpgradeHeaders, readSubscribeFrame } from './protocol.ts';

/** The tag prefix on every socket this object owns. */
const OWNER_TAG = 'owner';
const MAX_TOPICS_PER_SOCKET = 64;

export interface HubEnv {
  /**
   * How a subscription is authorized.
   *
   * A binding to the application Worker. Typed as the platform's own `Fetcher`
   * rather than a hand-written one-argument shape, so `fetch(url, init)` is the
   * real signature and a binding that does not match is a type error at the point
   * it is declared.
   */
  readonly AUTHORIZE: Fetcher;
}

/** The decision an authorize call came back with. */
export type SubscriptionDecision = 'allow' | 'deny';

export class LiveHub extends DurableObject<HubEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith('/attach')) {
      return this.#attach(request);
    }
    if (url.pathname.endsWith('/publish')) {
      return this.#publish(request);
    }
    return new Response('Not found.', { status: 404 });
  }

  /**
   * Take a socket from the Worker that verified its ticket.
   *
   * The identity arrives in a header rather than in the URL because the DO is
   * reached over a binding, never from the internet, and the Worker that called is
   * the one that decided who this is. The DO trusts that caller completely — it has
   * no way to check, and does not need to, because nothing else can reach it.
   */
  async #attach(request: Request): Promise<Response> {
    const userId = request.headers.get('x-live-user');
    if (userId === null || userId.length === 0) {
      return new Response('No verified identity.', { status: 401 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernation: the runtime keeps the socket and its tags. No timer is held for
    // this connection, which is the entire point.
    this.ctx.acceptWebSocket(server, [OWNER_TAG, userId]);
    server.serializeAttachment({ userId, topics: [] as string[] });

    return new Response(null, { status: 101, webSocket: client, headers: liveUpgradeHeaders() });
  }

  /**
   * Fan an invalidation out to whoever is watching this topic.
   *
   * Sent as a single byte plus the topic rather than as JSON: this crosses a
   * socket per subscriber on the Free plan's request budget, and the payload is
   * fixed-shape, so there is nothing to parse.
   */
  async #publish(request: Request): Promise<Response> {
    const topic = new URL(request.url).searchParams.get('topic');
    if (topic === null || topic.length === 0) {
      return new Response('A topic is required.', { status: 400 });
    }

    const frame = invalidateFrame(topic);
    let delivered = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as {
        userId: string;
        topics: string[];
      } | null;
      // Unknown attachment means a socket this object cannot account for. Skipped
      // rather than guessed at: delivering to it could reach a subscriber whose
      // authorization this object never saw.
      if (attachment === null || !attachment.topics.includes(topic)) {
        continue;
      }
      try {
        socket.send(frame);
        delivered += 1;
      } catch {
        // A socket that cannot be written to is closed below on its own event; a
        // failed fan-out to one subscriber must not stop the rest.
      }
    }

    return Response.json({ delivered });
  }

  /**
   * A socket asked to watch something.
   *
   * Authorized before it is recorded, and refused rather than optimistically
   * recorded: an unauthorized topic that was added first and checked later would
   * already have received a publish by the time the denial arrived.
   */
  override async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const topic = readSubscribeFrame(text);
    if (topic === null) {
      // The socket is closed rather than left subscribed: a frame this object
      // cannot read is a client that built the handshake wrong, and retrying the
      // same bytes will not help. 1008 is "policy violation", which the client
      // treats as "fall back to polling" rather than as an error worth retrying.
      socket.close(1008, 'A subscribe frame must name a topic.');
      return;
    }

    const attachment = socket.deserializeAttachment() as {
      userId: string;
      topics: string[];
    } | null;
    if (attachment === null) {
      socket.close(1011, 'This connection has no identity.');
      return;
    }

    if (attachment.topics.includes(topic)) {
      return;
    }

    const decision = await this.#authorize(attachment.userId, topic);
    if (decision !== 'allow') {
      // 1008 is "policy violation". The client treats a close as "reconnect and
      // fall back to polling" rather than as an error, because a denied
      // subscription is not a fault it can fix by retrying harder.
      socket.close(1008, 'Not authorized for this topic.');
      return;
    }

    // Authorization yields: re-read so concurrent subscribes cannot lose topics
    // or bypass the limit using an attachment captured before the await.
    const current = socket.deserializeAttachment() as typeof attachment | null;
    if (current === null || current.topics.includes(topic)) {
      return;
    }
    if (current.topics.length >= MAX_TOPICS_PER_SOCKET) {
      socket.close(1008, 'Too many subscribed topics.');
      return;
    }
    current.topics = [...current.topics, topic];
    socket.serializeAttachment(current);
  }

  /** A subscriber's topics are forgotten the moment it goes. */
  override async webSocketClose(
    socket: WebSocket,
    code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // Nothing to persist: topics live in the socket's attachment, which the runtime
    // discards with the socket. This override exists to say so — a reader looking
    // for the cleanup would otherwise assume there is a map somewhere.
    void socket;
    void code;
  }

  async #authorize(userId: string, topic: string): Promise<SubscriptionDecision> {
    try {
      const response = await this.env.AUTHORIZE.fetch('https://live.internal/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId, topic }),
      });
      if (!response.ok) {
        return 'deny';
      }
      const body = (await response.json()) as { decision?: unknown };
      return body.decision === 'allow' ? 'allow' : 'deny';
    } catch {
      // Unreachable is a denial, not a permission. A socket that cannot ask may not
      // watch: defaulting to allow would make an outage of the application Worker
      // an authorization bypass.
      return 'deny';
    }
  }
}

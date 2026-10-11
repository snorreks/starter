// packages/backend/auth/src/live/ticket.ts
//
// The credential a browser presents to open a live socket.
//
// **Why a ticket at all.** The socket endpoint is a different Worker from the one
// that serves the page, so the first-party session cookie does not travel with the
// upgrade — and re-scoping that cookie to a parent domain so it would would weaken
// it for every other route. So the browser asks the application it is already
// authenticated to for a short-lived bearer credential and presents that instead.
//
// **Why it rides in a subprotocol, not the query string.** A browser cannot set
// headers on a WebSocket, so the credential has to go somewhere in the handshake.
// The query string is the obvious place and it is the wrong one: URLs land in
// access logs, in proxy logs, and in `Referer` on any navigation the page
// triggers. `Sec-WebSocket-Protocol` is a header, is not logged by intermediaries,
// and this transport already has to send the negotiated protocol name back — so
// the credential rides alongside it and the server echoes only the name.
//
// **What the ticket is not.** It is not a session. It grants exactly one thing —
// "attach a socket for this user" — for a bounded time, and it is minted by a
// route that already required the session. A stolen ticket is worth a socket for
// whoever holds it, which is why the lifetime below is short and why this is a
// defence-in-depth measure rather than the only thing standing between a stranger
// and somebody's transcript: every subscription the socket opens is still
// authorized against the verified owner on the server.

import * as v from 'valibot';

/** The protocol name both ends negotiate. Never a secret. */
export const LIVE_PROTOCOL = 'starter.live.v1';

/**
 * How long a minted ticket is good for.
 *
 * 30 seconds is chosen against the round trip it has to survive: the browser mints,
 * opens the socket, and the handshake completes — all on one connection the user
 * already has open. Anything longer widens the window in which a ticket captured
 * from a log or a proxy is still usable, and buys nothing.
 */
export const LIVE_TICKET_TTL_MS = 30_000;

const TicketPayloadSchema = v.strictObject({
  /** The verified user the socket may act as. */
  u: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
  /** Expiry, epoch milliseconds. */
  e: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /**
   * A nonce, so two tickets minted in the same millisecond for the same user are
   * not byte-identical. Without it the token is a function of (user, clock) and a
   * log that captured one captures every ticket for that user in that second.
   */
  n: v.pipe(v.string(), v.minLength(8), v.maxLength(64)),
});

const encoder = new TextEncoder();

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromBase64Url = (value: string): Uint8Array<ArrayBuffer> | null => {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
};

const importKey = async (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);

const sign = async (secret: string, payload: string): Promise<string> => {
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return toBase64Url(new Uint8Array(signature));
};

export interface MintLiveTicketOptions {
  readonly secret: string;
  readonly userId: string;
  readonly now?: number;
  readonly ttlMs?: number;
  /** Injected so a test can prove two tickets are not identical. */
  readonly nonce?: () => string;
}

/**
 * Mint a ticket, or refuse.
 *
 * Refuses a short secret rather than signing with it: an HMAC keyed by a two-byte
 * string is forgeable by anyone who reads this file, and a deploy that
 * accidentally carries a weak secret should fail loudly here instead of issuing
 * credentials that look real.
 */
export const mintLiveTicket = async (options: MintLiveTicketOptions): Promise<string> => {
  const { secret, userId } = options;
  if (secret.length < 32) {
    throw new Error('The live ticket secret must be at least 32 characters.');
  }
  const now = options.now ?? Date.now();
  if (userId.length === 0 || userId.length > 64) {
    // Refused at the mint rather than caught at the verify: a ticket naming nobody
    // would verify, attach a socket, and authorize nothing.
    throw new Error('A live ticket must name a user.');
  }
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({
        u: userId,
        e: now + (options.ttlMs ?? LIVE_TICKET_TTL_MS),
        n: (options.nonce ?? (() => crypto.randomUUID()))(),
      }),
    ),
  );
  return `${payload}.${await sign(secret, payload)}`;
};

export type VerifyLiveTicketResult =
  | { readonly ok: true; readonly userId: string }
  | {
      readonly ok: false;
      readonly reason:
        | 'malformed'
        | 'bad-signature'
        | 'expired'
        | 'unsupported-protocol'
        | 'not-offered';
    };

/**
 * Verify a ticket and say precisely why not.
 *
 * Every refusal is a distinct reason rather than one boolean, because "the socket
 * was refused" with no cause is a bug report nobody can act on: an expired ticket
 * is a slow client, a bad signature is a wrong secret on one of the two Workers,
 * and `not-offered` is a caller that built the handshake wrong. They need
 * different fixes and they are counted separately.
 */
export const verifyLiveTicket = async (options: {
  readonly secret: string;
  readonly offeredProtocols: readonly string[];
  readonly now?: number;
}): Promise<VerifyLiveTicketResult> => {
  const now = options.now ?? Date.now();

  if (!options.offeredProtocols.includes(LIVE_PROTOCOL)) {
    return { ok: false, reason: 'not-offered' };
  }
  const token = options.offeredProtocols
    .slice(options.offeredProtocols.indexOf(LIVE_PROTOCOL) + 1)
    .find((value) => value.length > 0);
  if (token === undefined) {
    return { ok: false, reason: 'malformed' };
  }

  const separator = token.lastIndexOf('.');
  if (separator <= 0) {
    return { ok: false, reason: 'malformed' };
  }
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const presented = fromBase64Url(signature);
  if (presented === null) {
    return { ok: false, reason: 'malformed' };
  }

  let valid = false;
  try {
    const key = await importKey(options.secret);
    valid = await crypto.subtle.verify('HMAC', key, presented, encoder.encode(payload));
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
  if (!valid) {
    return { ok: false, reason: 'bad-signature' };
  }

  const decoded = fromBase64Url(payload);
  if (decoded === null) {
    return { ok: false, reason: 'malformed' };
  }
  const parsed = v.safeParse(TicketPayloadSchema, JSON.parse(new TextDecoder().decode(decoded)));
  if (!parsed.success) {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed.output.e <= now) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, userId: parsed.output.u };
};

/**
 * The single protocol value to echo back in `Sec-WebSocket-Protocol`.
 *
 * Only ever the name. Echoing the credential back in a response header would put
 * it in every log that records response headers, which is the problem the
 * subprotocol was chosen to avoid.
 */
export const liveAcceptProtocol = (): string => LIVE_PROTOCOL;

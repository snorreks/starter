// packages/backend/auth/src/live/ticket.test.ts
//
// The ticket that lets a browser reach the live socket.
//
// These drive real WebCrypto rather than a stand-in, because the properties under
// test — that a forgery is rejected, that an expiry is honoured, that a wrong
// secret is a different failure from a missing protocol — are properties of the
// HMAC and of the handshake, and a mock would only prove that the mock was called.

import { describe, expect, test } from 'bun:test';
import { LIVE_PROTOCOL, LIVE_TICKET_TTL_MS, mintLiveTicket, verifyLiveTicket } from './ticket.ts';

const SECRET = 'a-secret-long-enough-to-be-accepted-by-the-signer-0123456789';
const OTHER_SECRET = 'a-different-secret-that-is-also-long-enough-000000000000';
const USER = 'f45b2c4a-7919-4f55-ae89-e73f6753e322';

const NOW = 1_700_000_000_000;

describe('a ticket the application minted', () => {
  test('verifies and names the user it was minted for', async () => {
    const token = await mintLiveTicket({ secret: SECRET, userId: USER, now: NOW });

    const result = await verifyLiveTicket({
      secret: SECRET,
      offeredProtocols: [LIVE_PROTOCOL, token],
      now: NOW + 1_000,
    });

    expect(result).toEqual({ ok: true, userId: USER });
  });

  test('carries no session material — only the user id and an expiry', async () => {
    const token = await mintLiveTicket({ secret: SECRET, userId: USER, now: NOW });
    const payload = token.slice(0, token.lastIndexOf('.'));

    const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    expect(decoded).toContain(USER);
    // Nothing that could be replayed as a session.
    expect(decoded).not.toContain('access_token');
    expect(decoded).not.toContain('refresh_token');
  });

  test('two tickets minted at the same instant differ', async () => {
    const first = await mintLiveTicket({ secret: SECRET, userId: USER, now: NOW });
    const second = await mintLiveTicket({ secret: SECRET, userId: USER, now: NOW });

    // Same user, same clock. If these matched, a log holding one would hold every
    // ticket for that user in that second.
    expect(first).not.toBe(second);
    for (const token of [first, second]) {
      expect(
        await verifyLiveTicket({
          secret: SECRET,
          offeredProtocols: [LIVE_PROTOCOL, token],
          now: NOW,
        }),
      ).toEqual({ ok: true, userId: USER });
    }
  });
});

describe('a ticket that should not be honoured', () => {
  test('expires', async () => {
    const token = await mintLiveTicket({ secret: SECRET, userId: USER, now: NOW });

    const justBefore = await verifyLiveTicket({
      secret: SECRET,
      offeredProtocols: [LIVE_PROTOCOL, token],
      now: NOW + LIVE_TICKET_TTL_MS - 1,
    });
    const justAfter = await verifyLiveTicket({
      secret: SECRET,
      offeredProtocols: [LIVE_PROTOCOL, token],
      now: NOW + LIVE_TICKET_TTL_MS,
    });

    expect(justBefore.ok).toBe(true);
    // Expiry is inclusive: at the boundary the ticket is already spent.
    expect(justAfter).toEqual({ ok: false, reason: 'expired' });
  });

  test('is rejected by a Worker holding a different secret', async () => {
    const token = await mintLiveTicket({ secret: SECRET, userId: USER, now: NOW });

    expect(
      await verifyLiveTicket({
        secret: OTHER_SECRET,
        offeredProtocols: [LIVE_PROTOCOL, token],
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'bad-signature' });
  });

  test('is rejected once its payload is edited, even keeping the signature', async () => {
    const token = await mintLiveTicket({ secret: SECRET, userId: USER, now: NOW });
    const separator = token.lastIndexOf('.');
    const forged = `${token.slice(0, separator).slice(0, -2)}AA.${token.slice(separator + 1)}`;

    expect(
      await verifyLiveTicket({
        secret: SECRET,
        offeredProtocols: [LIVE_PROTOCOL, forged],
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'bad-signature' });
  });

  test('cannot be smuggled in without offering the protocol name', async () => {
    const token = await mintLiveTicket({ secret: SECRET, userId: USER, now: NOW });

    // A caller that built the handshake with the credential first: the protocol
    // name is present, so this is not `not-offered` — it is a handshake that named
    // the protocol and carried no credential beside it.
    expect(
      await verifyLiveTicket({
        secret: SECRET,
        offeredProtocols: [token, LIVE_PROTOCOL],
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(
      await verifyLiveTicket({ secret: SECRET, offeredProtocols: [LIVE_PROTOCOL], now: NOW }),
    ).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifyLiveTicket({ secret: SECRET, offeredProtocols: [], now: NOW })).toEqual({
      ok: false,
      reason: 'not-offered',
    });
  });

  test('is refused when the handshake offers garbage', async () => {
    for (const offered of [
      [LIVE_PROTOCOL, 'no-separator'],
      [LIVE_PROTOCOL, '.leading'],
      [LIVE_PROTOCOL, '!!!.???'],
    ]) {
      const result = await verifyLiveTicket({
        secret: SECRET,
        offeredProtocols: offered,
        now: NOW,
      });
      expect(result.ok).toBe(false);
    }
  });
});

describe('minting', () => {
  test('refuses a secret too short to be a key', async () => {
    // A two-byte HMAC key is forgeable by anyone who has read the signer.
    await expect(mintLiveTicket({ secret: 'short', userId: USER, now: NOW })).rejects.toThrow(
      /at least 32 characters/,
    );
  });

  test('refuses an empty user, which would attach a socket to nobody', async () => {
    await expect(mintLiveTicket({ secret: SECRET, userId: '', now: NOW })).rejects.toThrow();
  });
});

test('a correctly signed payload with invalid JSON is malformed', async () => {
  const payload = Buffer.from('{not json').toString('base64url');
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const token = `${payload}.${Buffer.from(signature).toString('base64url')}`;
  await expect(
    verifyLiveTicket({ secret: SECRET, offeredProtocols: [LIVE_PROTOCOL, token], now: NOW }),
  ).resolves.toEqual({ ok: false, reason: 'malformed' });
});

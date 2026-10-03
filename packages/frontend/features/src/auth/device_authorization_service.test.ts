// packages/frontend/features/src/auth/device_authorization_service.test.ts
//
// The polling loop, driven against a fake transport and a fake clock.
//
// These are the four answers that are not successes, plus cancellation. Each of
// them is a way a real sign-in either hangs or is refused, and none of them can
// be observed without a transport that says so — which is why this lane fakes the
// transport rather than mocking the service.

import { describe, expect, test } from 'bun:test';
import type { ApiTransport } from '@starter/platform';
import { AppError } from '@starter/utils';
import {
  createDeviceAuthorizationService,
  DEVICE_CODE_GRANT_TYPE,
  type DeviceAuthorizationEvent,
  type Sleeper,
} from './device_authorization_service.ts';

const CODE = {
  device_code: 'device-code-value',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://api.example.test/device',
  verification_uri_complete: 'https://api.example.test/device?user_code=ABCD-EFGH',
  expires_in: 600,
  interval: 5,
};

/**
 * A transport that answers the code request, then a scripted token sequence.
 *
 * The script is consumed as it is read, so a case can assert how many polls it took.
 * Every script here ends in something other than `authorization_pending`: a script
 * with no end is an endless loop, and a hanging test is worse than a failing one.
 */
const scriptedTransport = (
  tokenResponses: { ok?: Record<string, unknown>; error?: string }[],
  calls: { paths: string[]; bodies: unknown[] },
): ApiTransport => ({
  request: <T>(path: string, options?: { body?: unknown }): Promise<T> => {
    calls.paths.push(path);
    calls.bodies.push(options?.body);

    if (path === '/api/auth/device/code') {
      return Promise.resolve(CODE as unknown as T);
    }

    const next = tokenResponses.shift() ?? { error: 'authorization_pending' };
    if (next.ok !== undefined) {
      return Promise.resolve(next.ok as T);
    }
    return Promise.reject(
      new AppError('validation', 'The request failed.', {
        status: 400,
        cause: { error: next.error, error_description: 'from the provider' },
      }),
    );
  },
});

const noSleep: Sleeper = () => Promise.resolve();

describe('asking for a code', () => {
  test('sends the public client id and validates the answer', async () => {
    const calls = { paths: [] as string[], bodies: [] as unknown[] };
    const service = createDeviceAuthorizationService({
      transport: scriptedTransport([], calls),
      clientId: 'starter-native-desktop',
      sleep: noSleep,
    });

    const code = await service.requestCode();

    expect(code.user_code).toBe('ABCD-EFGH');
    expect(calls.bodies[0]).toEqual({ client_id: 'starter-native-desktop', scope: '' });
  });

  test('refuses a response this build does not understand', async () => {
    // A renamed field must not become a screen waiting on a code that does not
    // exist.
    const transport: ApiTransport = {
      request: <T>(): Promise<T> =>
        Promise.resolve({ ...CODE, interval: undefined } as unknown as T),
    };
    const service = createDeviceAuthorizationService({ transport, clientId: 'c', sleep: noSleep });

    await expect(service.requestCode()).rejects.toThrow(/does not understand/);
  });
});

describe('waiting for a person', () => {
  test('keeps polling while the answer is "pending"', async () => {
    const calls = { paths: [] as string[], bodies: [] as unknown[] };
    const service = createDeviceAuthorizationService({
      transport: scriptedTransport(
        [
          { error: 'authorization_pending' },
          { error: 'authorization_pending' },
          // The third poll is the one that succeeds: the script has to end in an
          // approval, because a pending script with no end is an endless loop and
          // a hanging test is worse than a failing one.
          { ok: { access_token: 'token', token_type: 'Bearer', expires_in: 60, scope: '' } },
        ],
        calls,
      ),
      clientId: 'c',
      sleep: noSleep,
    });

    const outcome = await service.awaitApproval(CODE, new AbortController().signal);

    expect(outcome.status).toBe('approved');
    expect(calls.paths.filter((path) => path === '/api/auth/device/token')).toHaveLength(3);
  });

  test('the token request carries the grant type the endpoint requires', async () => {
    // The pinned plugin validates this body against RFC 8628's schema, which
    // requires the literal. Without it every poll is refused as
    // `invalid_request` and the sign-in can never succeed.
    const calls = { paths: [] as string[], bodies: [] as unknown[] };
    const service = createDeviceAuthorizationService({
      transport: scriptedTransport(
        [{ ok: { access_token: 't', token_type: 'Bearer', expires_in: 60, scope: '' } }],
        calls,
      ),
      clientId: 'starter-native-desktop',
      sleep: noSleep,
    });

    await service.awaitApproval(CODE, new AbortController().signal);

    expect(calls.bodies[0]).toEqual({
      grant_type: DEVICE_CODE_GRANT_TYPE,
      device_code: CODE.device_code,
      client_id: 'starter-native-desktop',
    });
  });

  test('backs off by five seconds on slow_down and keeps waiting', async () => {
    // The behaviour RFC 8628 §3.5 asks for, and the one a naive client gets
    // wrong by treating a back-off as a failure.
    const events: DeviceAuthorizationEvent[] = [];
    const slept: number[] = [];
    const calls = { paths: [] as string[], bodies: [] as unknown[] };
    const service = createDeviceAuthorizationService({
      transport: scriptedTransport(
        [
          { error: 'slow_down' },
          { error: 'slow_down' },
          { ok: { access_token: 'token', token_type: 'Bearer', expires_in: 60, scope: '' } },
        ],
        calls,
      ),
      clientId: 'c',
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
      onEvent: (event) => events.push(event),
    });

    const outcome = await service.awaitApproval(CODE, new AbortController().signal);

    expect(outcome.status).toBe('approved');
    // The server's 5s interval, then 10s, then 15s.
    expect(slept).toEqual([5_000, 10_000, 15_000]);
    expect(events.filter((event) => event.kind === 'slow_down')).toHaveLength(2);
  });

  test('never polls faster than the server asked', async () => {
    // A server answering `interval: 0` (or a client reading a missing field as
    // zero) would otherwise become a hot loop against an endpoint whose rate
    // limit is small.
    const slept: number[] = [];
    const calls = { paths: [] as string[], bodies: [] as unknown[] };
    const service = createDeviceAuthorizationService({
      transport: scriptedTransport(
        [{ ok: { access_token: 't', token_type: 'Bearer', expires_in: 1, scope: '' } }],
        calls,
      ),
      clientId: 'c',
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    await service.awaitApproval({ ...CODE, interval: 0 }, new AbortController().signal);

    expect(slept).toEqual([5_000]);
  });

  test('a denial is terminal and is never retried', async () => {
    const calls = { paths: [] as string[], bodies: [] as unknown[] };
    const service = createDeviceAuthorizationService({
      transport: scriptedTransport([{ error: 'access_denied' }], calls),
      clientId: 'c',
      sleep: noSleep,
    });

    const outcome = await service.awaitApproval(CODE, new AbortController().signal);

    expect(outcome.status).toBe('denied');
    expect(calls.paths.filter((path) => path === '/api/auth/device/token')).toHaveLength(1);
  });

  test('an expiry from the server is terminal', async () => {
    const service = createDeviceAuthorizationService({
      transport: scriptedTransport([{ error: 'expired_token' }], { paths: [], bodies: [] }),
      clientId: 'c',
      sleep: noSleep,
    });

    expect((await service.awaitApproval(CODE, new AbortController().signal)).status).toBe(
      'expired',
    );
  });

  test('the deadline ends the flow even if the server keeps saying pending', async () => {
    // An outage in which the server answers "pending" forever must not become a
    // sign-in that waits forever: `expires_in` is the server's own bound.
    let clock = 1_000;
    const calls = { paths: [] as string[], bodies: [] as unknown[] };
    const service = createDeviceAuthorizationService({
      transport: scriptedTransport([], calls),
      clientId: 'c',
      sleep: () => {
        clock += 10_000;
        return Promise.resolve();
      },
      now: () => clock,
    });

    // A one-minute code, a ten-second step: the loop must end near six polls, not
    // run until something else stops it.
    const outcome = await service.awaitApproval(
      { ...CODE, expires_in: 60 },
      new AbortController().signal,
    );

    expect(outcome.status).toBe('expired');
    expect(calls.paths.filter((path) => path === '/api/auth/device/token').length).toBeLessThan(8);
  });

  test('a non-device failure is propagated, not retried', async () => {
    const transport: ApiTransport = {
      request: <T>(): Promise<T> =>
        Promise.reject(new AppError('server', 'The request failed.', { status: 500 })),
    };
    const service = createDeviceAuthorizationService({ transport, clientId: 'c', sleep: noSleep });

    // Polling through an outage is how a sign-in appears to hang.
    await expect(service.awaitApproval(CODE, new AbortController().signal)).rejects.toThrow(
      'The request failed.',
    );
  });
});

describe('cancelling', () => {
  test('an already-aborted signal stops before the first poll', async () => {
    const controller = new AbortController();
    controller.abort();
    const calls = { paths: [] as string[], bodies: [] as unknown[] };
    const service = createDeviceAuthorizationService({
      transport: scriptedTransport([], calls),
      clientId: 'c',
      sleep: noSleep,
    });

    await expect(service.awaitApproval(CODE, controller.signal)).rejects.toThrow(/cancelled/);
    expect(calls.paths).toEqual([]);
  });

  test('aborting mid-wait ends the loop instead of the next wakeup', async () => {
    // A screen that unmounts must release the device code, not keep a timer alive
    // on a screen nobody is looking at.
    const controller = new AbortController();
    const calls = { paths: [] as string[], bodies: [] as unknown[] };
    const service = createDeviceAuthorizationService({
      transport: scriptedTransport([], calls),
      clientId: 'c',
      sleep: () => {
        controller.abort();
        return Promise.resolve();
      },
    });

    await expect(service.awaitApproval(CODE, controller.signal)).rejects.toThrow(/cancelled/);
    expect(calls.paths).toEqual([]);
  });
});

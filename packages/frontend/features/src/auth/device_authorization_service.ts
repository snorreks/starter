// packages/frontend/features/src/auth/device_authorization_service.ts
//
// The client half of RFC 8628: ask for a code, show it, poll until a person acts.
//
// Why this is in the shared package and not in the native app
// -----------------------------------------------------------
// It has no host in it. It talks to two endpoints through an injected transport,
// it opens nothing, and it renders nothing — the native shell, and any mobile
// build that follows, use this exact file. A second copy in an application is a
// second polling loop that will eventually disagree about `slow_down`.
//
// The rules it implements, and each one is a way to hang or to fail a real
// sign-in:
//
//   * **The server's interval is the floor.** `interval` comes from the code
//     response and this client never polls faster. RFC 8628's `slow_down` exists
//     because a client that polls too fast gets its device code refused, and the
//     server's `rateLimit` for `/device` is small enough that "a few times
//     quickly" is reachable by accident.
//   * **`slow_down` is not a failure, it is a reply to a fast poll.** The device
//     code is still valid; RFC 8628 §3.5 says to add five seconds and poll again.
//     Treating it as an error ends a sign-in that was about to succeed, which is
//     the single most confusing outcome this flow can produce.
//   * **`access_denied` is terminal, and never retried.** Somebody pressed Deny.
//     Polling again would either be ignored or would look like an attack.
//   * **`expired_token` is terminal.** The code is gone; a new one is needed.
//   * **The deadline is the server's `expires_in`,** compared against an injected
//     clock, so the flow ends even if the server stops answering `expired_token`.
//   * **Cancellation is cooperative and immediate.** An `AbortSignal` stops the
//     wait *and* the in-flight request, which is what a screen that unmounts — or
//     an app that is being closed — needs. Without it the loop keeps a wakeup
//     pending on a screen nobody is looking at, holding a device code alive.
//
// Nothing here opens a browser and nothing stores a token. The caller decides
// where the user goes (`ExternalBrowser`) and where the token lands
// (`SessionStore`); this file only asks a server a question and waits.

import { Value } from '@sinclair/typebox/value';
import type { ApiTransport } from '@starter/platform';
import { parseDto } from '@starter/platform';
import {
  type DeviceCodeResponse,
  DeviceCodeResponseSchema,
  type DeviceTokenError,
  type DeviceTokenErrorResponse,
  DeviceTokenErrorResponseSchema,
  type DeviceTokenResponse,
  DeviceTokenResponseSchema,
  MIN_DEVICE_POLL_INTERVAL_MS,
  SLOW_DOWN_INCREMENT_MS,
} from '@starter/schemas/auth';
import { AppError } from '@starter/utils';

/**
 * RFC 8628's device-code grant type, verbatim.
 *
 * The token endpoint validates its body against a schema that *requires* this
 * literal. A request without it is refused as `invalid_request` before the device
 * code is looked up, so a client that omits it can never sign in — for a reason
 * that has nothing to do with the code it was given.
 */
export const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** How a poll ended. `approved` is the only one that produces a credential. */
export type DeviceAuthorizationOutcome =
  | { readonly status: 'approved'; readonly token: DeviceTokenResponse }
  | { readonly status: 'denied' }
  | { readonly status: 'expired' };

export type DeviceAuthorizationEvent =
  | { readonly kind: 'waiting'; readonly attempt: number; readonly intervalMs: number }
  | { readonly kind: 'slow_down'; readonly attempt: number; readonly intervalMs: number };

/**
 * Wait, cancellably.
 *
 * Injected so the unit lane can drive the whole loop without real time passing,
 * and so a future host can substitute its own scheduler. The default resolves
 * early when the signal fires, so a cancelled flow does not sit out its interval.
 */
export type Sleeper = (ms: number, signal: AbortSignal) => Promise<void>;

const defaultSleeper: Sleeper = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

/**
 * The four answers that are not successes, read out of a transport failure.
 *
 * Validated against the shared schema rather than pattern-matched, because the
 * difference between "the provider said `slow_down`" and "something returned a
 * JSON object with an `error` field" is the difference between backing off and
 * reporting an outage. An error body this build does not understand is `null`,
 * which the caller propagates rather than treats as a device state.
 */
const readDeviceError = (error: unknown): DeviceTokenError | null => {
  if (!(error instanceof AppError)) {
    return null;
  }
  const cause: unknown = error.cause;
  return Value.Check(DeviceTokenErrorResponseSchema, cause)
    ? (cause as DeviceTokenErrorResponse).error
    : null;
};

export interface DeviceAuthorizationServiceOptions {
  readonly transport: ApiTransport;
  /**
   * The public client identifier.
   *
   * Required rather than defaulted, because the value belongs to whoever ships
   * the client. A default here would be a shared client id in every app built
   * from this template, which is one revocation away from affecting all of them.
   */
  readonly clientId: string;
  readonly sleep?: Sleeper;
  readonly now?: () => number;
  /** Progress, for a screen that shows "still waiting". Never token material. */
  readonly onEvent?: (event: DeviceAuthorizationEvent) => void;
}

export interface DeviceAuthorizationService {
  /** Ask the server for a device code and a user code. */
  requestCode(signal?: AbortSignal): Promise<DeviceCodeResponse>;
  /**
   * Poll until the user approves, denies, or the code expires.
   *
   * Rejects with an `aborted` `AppError` when `signal` fires; that is a lifecycle
   * event, not a failure, and a caller that treats it as one will show an error
   * on every navigation away.
   */
  awaitApproval(code: DeviceCodeResponse, signal: AbortSignal): Promise<DeviceAuthorizationOutcome>;
}

export const createDeviceAuthorizationService = (
  options: DeviceAuthorizationServiceOptions,
): DeviceAuthorizationService => {
  const sleep = options.sleep ?? defaultSleeper;
  const now = options.now ?? Date.now;

  const requestCode = async (signal?: AbortSignal): Promise<DeviceCodeResponse> => {
    const body = await options.transport.request<unknown>('/api/auth/device/code', {
      method: 'POST',
      body: { client_id: options.clientId, scope: '' },
      ...(signal === undefined ? {} : { signal }),
    });

    return parseDto(DeviceCodeResponseSchema, body, 'a device code');
  };

  const awaitApproval = async (
    code: DeviceCodeResponse,
    signal: AbortSignal,
  ): Promise<DeviceAuthorizationOutcome> => {
    const expiresAt = now() + code.expires_in * 1_000;
    let intervalMs = Math.max(code.interval * 1_000, MIN_DEVICE_POLL_INTERVAL_MS);
    let attempt = 0;

    for (;;) {
      if (signal.aborted) {
        throw new AppError('aborted', 'The sign-in was cancelled.');
      }
      if (now() >= expiresAt) {
        return { status: 'expired' };
      }

      await sleep(intervalMs, signal);
      if (signal.aborted) {
        throw new AppError('aborted', 'The sign-in was cancelled.');
      }

      attempt += 1;

      let body: unknown;
      try {
        body = await options.transport.request<unknown>('/api/auth/device/token', {
          method: 'POST',
          body: {
            grant_type: DEVICE_CODE_GRANT_TYPE,
            device_code: code.device_code,
            client_id: options.clientId,
          },
          signal,
        });
      } catch (error) {
        const deviceError = readDeviceError(error);

        switch (deviceError) {
          case 'authorization_pending':
            options.onEvent?.({ kind: 'waiting', attempt, intervalMs });
            continue;
          case 'slow_down':
            // RFC 8628 §3.5: back off by five seconds and keep going.
            intervalMs += SLOW_DOWN_INCREMENT_MS;
            options.onEvent?.({ kind: 'slow_down', attempt, intervalMs });
            continue;
          case 'access_denied':
            return { status: 'denied' };
          case 'expired_token':
            return { status: 'expired' };
          default:
            // A transport failure that is not one of the four device answers — a
            // 500, a dead network, a shape this build does not understand — is
            // propagated rather than retried. Silently polling through an outage
            // is how a sign-in appears to hang.
            throw error;
        }
      }

      return {
        status: 'approved',
        token: parseDto(DeviceTokenResponseSchema, body, 'a device token'),
      };
    }
  };

  return { requestCode, awaitApproval };
};

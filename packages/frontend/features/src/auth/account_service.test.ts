// packages/frontend/features/src/auth/account_service.test.ts
//
// The two rules the account endpoints exist to enforce, both of which used to live
// in the web app and are now shared.
//
// Neither is a web-only rule. A recovery link carrying a credential must not be
// nominatable by a screen on *any* host, and the confirmation bounce has to land
// back on the application rather than wherever a caller felt like.

import { describe, expect, test } from 'bun:test';
import type { ApiTransport, TransportRequestOptions } from '@starter/platform';
import { AppError } from '@starter/utils';
import { createAccountService, VERIFICATION_RETURN_PATH } from './account_service.ts';

interface Recorded {
  readonly path: string;
  readonly options: TransportRequestOptions | undefined;
}

const recordingTransport = (calls: Recorded[]): ApiTransport => ({
  async request<T>(path: string, options?: TransportRequestOptions): Promise<T> {
    calls.push({ path, options });
    return undefined as T;
  },
});

const service = (calls: Recorded[] = []) => createAccountService(recordingTransport(calls));

describe('a recovery link may only come back to this site', () => {
  test('an absolute destination is refused before a request is built', async () => {
    const calls: Recorded[] = [];
    const failure = (await service(calls)
      .requestPasswordReset({ email: 'someone@example.test', redirectTo: 'https://attacker.test' })
      .catch((error: unknown) => error)) as AppError;

    // The failure this prevents: a link carrying a valid reset token delivered to
    // an address the user never asked for. Refusing to *build* the request means
    // a careless or compromised screen cannot nominate that destination at all.
    expect(failure).toBeInstanceOf(AppError);
    expect(failure.errorType).toBe('validation');
    // No request went out, so there is nothing to rate-limit and nothing to leak.
    expect(calls).toEqual([]);
  });

  test('a protocol-relative destination is refused too', async () => {
    const calls: Recorded[] = [];

    // `//evil.test/reset` parses as a relative URL, so a naive `startsWith('/')`
    // check accepts it — and the browser navigates cross-origin.
    const failure = (await service(calls)
      .requestPasswordReset({ email: 'someone@example.test', redirectTo: '//evil.test/reset' })
      .catch((error: unknown) => error)) as AppError;

    expect(failure.errorType).toBe('validation');
    expect(calls).toEqual([]);
  });

  test('a path on this site is accepted', async () => {
    const calls: Recorded[] = [];

    await service(calls).requestPasswordReset({
      email: 'someone@example.test',
      redirectTo: '/reset-password',
    });

    expect(calls[0]?.path).toBe('/api/auth/request-password-reset');
    expect(calls[0]?.options?.method).toBe('POST');
  });
});

describe('the confirmation bounce is a constant, not a parameter', () => {
  test('a resend returns to this application whatever the caller has', async () => {
    const calls: Recorded[] = [];

    await service(calls).sendVerificationEmail({ email: 'someone@example.test' });

    const body = calls[0]?.options?.body as { callbackURL: string } | undefined;
    expect(body?.callbackURL).toBe(VERIFICATION_RETURN_PATH);
  });

  test('the body carries only the address, not the address under another key', async () => {
    // `callbackURL` is the only destination the provider follows, and an extra
    // address-shaped field is how a "callback" becomes a second recipient.
    const calls: Recorded[] = [];

    await service(calls).sendVerificationEmail({ email: 'someone@example.test' });

    expect(calls[0]?.options?.body).toEqual({
      email: 'someone@example.test',
      callbackURL: '/verify-email',
    });
  });
});

describe('nothing here retries', () => {
  test('a refused resend produces exactly one request', async () => {
    // Better Auth allows three verification emails per minute per IP. A screen that
    // retried this would spend another user's quota on their own impatience.
    const calls: Recorded[] = [];
    const transport: ApiTransport = {
      request: async (path, options) => {
        calls.push({ path, options });
        throw new AppError('rate_limited', 'Too many requests.', { status: 429 });
      },
    };

    await createAccountService(transport)
      .sendVerificationEmail({ email: 'someone@example.test' })
      .catch(() => undefined);

    expect(calls).toHaveLength(1);
  });
});
